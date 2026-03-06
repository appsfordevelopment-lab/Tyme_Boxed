const express = require('express');
const twilio = require('twilio');
const OTP = require('../models/OTP');
const crypto = require('crypto');

const router = express.Router();

// Initialize Twilio client (only if credentials are available)
let twilioClient = null;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

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
  console.warn('[Twilio] Credentials not found. Phone OTP will not work. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env');
}
if (twilioClient && verifyServiceSid) {
  console.log('[Twilio] Verify Service enabled:', verifyServiceSid);
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
      // Validate E.164: 10–15 digits after + (covers most countries)
      if (digits.length < 10 || digits.length > 15) {
        return res.status(400).json({
          success: false,
          message: 'Invalid phone number. Please include country code (e.g. +1, +44, +91) and full number.'
        });
      }
    }

    // Rate limiting
    const canSend = await checkRateLimit(identifier, type);
    if (!canSend) {
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.'
      });
    }

    // Send OTP via Twilio Verify (phone) or email service
    if (type === 'phone') {
      if (!twilioClient || !verifyServiceSid) {
        return res.status(500).json({
          success: false,
          message: 'SMS service is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID in .env'
        });
      }

      try {
        // Twilio Verify: generates and sends OTP automatically (no phone number purchase needed)
        const verification = await twilioClient.verify.v2
          .services(verifyServiceSid)
          .verifications.create({
            to: identifier,
            channel: 'sms'
          });

        // Create OTP record for rate limiting only (Verify handles the actual code)
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        await OTP.create({
          identifier,
          otp: 'verify',
          type,
          expiresAt
        });

        console.log(`[OTP] Verify SMS sent to ${identifier}, SID: ${verification.sid}`);
      } catch (twilioError) {
        console.error(
          '[OTP] Twilio Verify error:',
          JSON.stringify({
            code: twilioError?.code,
            status: twilioError?.status,
            message: twilioError?.message,
            moreInfo: twilioError?.moreInfo
          })
        );
        const code = twilioError?.code;
        const twilioMsg = twilioError?.message || '';
        let userMessage = 'Failed to send OTP. Please check your phone number and try again.';
        if (code === 21408 || twilioMsg.includes('region') || twilioMsg.includes('permission')) {
          userMessage = 'SMS is not enabled for this country. Please contact support or try another number.';
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
      // Email OTP: generate and store ourselves
      const otpCode = generateOTP();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await OTP.create({
        identifier,
        otp: otpCode,
        type,
        expiresAt
      });
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

    if (type === 'phone') {
      // Phone: verify via Twilio Verify API
      if (!twilioClient || !verifyServiceSid) {
        return res.status(500).json({
          success: false,
          message: 'SMS service is not configured. Please contact support.'
        });
      }

      try {
        const verificationCheck = await twilioClient.verify.v2
          .services(verifyServiceSid)
          .verificationChecks.create({
            to: identifier,
            code: otp
          });

        if (verificationCheck.status !== 'approved') {
          return res.status(400).json({
            success: false,
            message: 'Invalid or expired OTP. Please request a new one.'
          });
        }
      } catch (twilioError) {
        console.error('[OTP] Twilio Verify check error:', twilioError?.message);
        return res.status(400).json({
          success: false,
          message: 'Invalid or expired OTP. Please request a new one.'
        });
      }
    } else {
      // Email: verify against our DB
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

      if (otpRecord.attempts >= 5) {
        return res.status(400).json({
          success: false,
          message: 'Too many failed attempts. Please request a new OTP.'
        });
      }

      if (otpRecord.otp !== otp) {
        otpRecord.attempts += 1;
        await otpRecord.save();
        return res.status(400).json({
          success: false,
          message: 'Invalid OTP. Please try again.'
        });
      }

      otpRecord.verified = true;
      otpRecord.verifiedAt = new Date();
      await otpRecord.save();
    }

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
