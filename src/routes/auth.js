const express = require('express');
const twilio = require('twilio');
const OTP = require('../models/OTP');
const crypto = require('crypto');

const router = express.Router();

// Initialize Twilio client (only if credentials are available)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log('[Twilio] Client initialized successfully');
  } catch (error) {
    console.error('[Twilio] Failed to initialize client:', error.message);
  }
} else {
  console.warn('[Twilio] Credentials not found. Phone OTP will not work. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER in .env');
}
if (twilioClient && process.env.TWILIO_MESSAGING_SERVICE_SID) {
  console.log('[Twilio] Messaging Service enabled:', process.env.TWILIO_MESSAGING_SERVICE_SID);
}

// Generate 6-digit OTP
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Rate limiting: Check if too many requests in the last hour
async function checkRateLimit(identifier, type) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentOTPs = await OTP.countDocuments({
    identifier,
    type,
    createdAt: { $gte: oneHourAgo }
  });
  return recentOTPs < 5; // Max 5 requests per hour
}

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { email, phone } = req.body;

    // Validate input
    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Either email or phone is required'
      });
    }

    const type = email ? 'email' : 'phone';
    let identifier = email || phone;

    // For phone: normalize to E.164 and use for both Twilio and OTP identifier
    if (type === 'phone' && phone) {
      const digits = phone.replace(/\D/g, '');
      const e164 = digits ? `+${digits}` : phone;
      identifier = e164;
    }

    // Rate limiting
    const canSend = await checkRateLimit(identifier, type);
    if (!canSend) {
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.'
      });
    }

    // Generate OTP
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Save OTP to database
    await OTP.create({
      identifier,
      otp: otpCode,
      type,
      expiresAt
    });

    // Send OTP via Twilio (for phone) or email service
    if (type === 'phone') {
      if (!twilioClient) {
        return res.status(500).json({
          success: false,
          message: 'SMS service is not configured. Please contact support.'
        });
      }

      const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;

      if (!messagingServiceSid && !fromNumber) {
        return res.status(500).json({
          success: false,
          message: 'SMS service is not configured. Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER in .env'
        });
      }

      try {
        // Use Messaging Service (picks best sender per destination) or fallback to single number
        const messageParams = {
          body: `Your Time Boxed verification code is: ${otpCode}. This code expires in 5 minutes.`,
          to: identifier
        };
        if (messagingServiceSid) {
          messageParams.messagingServiceSid = messagingServiceSid;
        } else {
          messageParams.from = fromNumber;
        }

        const message = await twilioClient.messages.create(messageParams);

        console.log(`[OTP] SMS sent to ${identifier}, SID: ${message.sid}`);
      } catch (twilioError) {
        console.error('[OTP] Twilio error:', twilioError);
        const code = twilioError?.code;
        const twilioMsg = twilioError?.message || '';
        let userMessage = 'Failed to send OTP. Please check your phone number and try again.';
        if (code === 21612 || (twilioMsg.includes('To') && twilioMsg.includes('From'))) {
          userMessage =
            'SMS cannot be sent to this country with the current setup. Please try with an Indian number (+91) or contact support.';
        } else if (code === 21408 || twilioMsg.includes('region') || twilioMsg.includes('permission')) {
          userMessage =
            'SMS is not enabled for this country. Please try with an Indian number (+91) or contact support.';
        } else if (code === 21211 || twilioMsg.includes('invalid')) {
          userMessage = 'Invalid phone number. Please check the number and country code.';
        } else if (code === 30004 || twilioMsg.includes('blocked')) {
          userMessage = 'SMS delivery is blocked for this number. Please try another number.';
        } else if (twilioMsg) {
          userMessage = twilioMsg;
        }
        return res.status(500).json({
          success: false,
          message: userMessage
        });
      }
    } else {
      // Email OTP - implement email service here if needed
      // For now, just log it
      console.log(`[OTP] Email OTP for ${email}: ${otpCode}`);
    }

    res.json({
      success: true,
      message: `OTP sent successfully to ${type === 'phone' ? 'your phone' : 'your email'}`,
      expiresIn: 300 // 5 minutes in seconds
    });
  } catch (error) {
    console.error('[OTP] Send error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP. Please try again.'
    });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, phone, otp } = req.body;

    // Validate input
    if (!otp) {
      return res.status(400).json({
        success: false,
        message: 'OTP is required'
      });
    }

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Either email or phone is required'
      });
    }

    const type = email ? 'email' : 'phone';
    let identifier = email || phone;
    // Normalize phone to E.164 to match send-otp identifier
    if (type === 'phone' && phone) {
      const digits = phone.replace(/\D/g, '');
      identifier = digits ? `+${digits}` : phone;
    }

    // Find the most recent unverified OTP for this identifier
    const otpRecord = await OTP.findOne({
      identifier,
      type,
      verified: false,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP. Please request a new one.'
      });
    }

    // Check attempts
    if (otpRecord.attempts >= 5) {
      return res.status(400).json({
        success: false,
        message: 'Too many failed attempts. Please request a new OTP.'
      });
    }

    // Verify OTP
    if (otpRecord.otp !== otp) {
      otpRecord.attempts += 1;
      await otpRecord.save();

      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.'
      });
    }

    // Mark as verified and save in OTP table (login record)
    otpRecord.verified = true;
    otpRecord.verifiedAt = new Date();
    await otpRecord.save();

    // Generate a simple token (you can use JWT here if needed)
    const token = crypto.randomBytes(32).toString('hex');

    res.json({
      success: true,
      message: 'OTP verified successfully',
      token
    });
  } catch (error) {
    console.error('[OTP] Verify error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP. Please try again.'
    });
  }
});

module.exports = router;
