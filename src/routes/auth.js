const express = require('express');
const twilio = require('twilio');
const { OAuth2Client } = require('google-auth-library');
const verifyAppleToken = require('verify-apple-id-token').default;
const OTP = require('../models/OTP');
const User = require('../models/User');
const AuthToken = require('../models/AuthToken');
const crypto = require('crypto');

// Google Client ID - supports both env var names
const googleClientId =
  process.env.GOOGLE_CLIENT_ID || process.env.Google_Client_ID;

// Apple Sign In: clientId is the app's bundle ID (e.g. com.tymeboxed.app)
const appleClientId =
  process.env.APPLE_CLIENT_ID || process.env.APPLE_BUNDLE_ID || 'com.tymeboxed.app';

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
  console.log('[Twilio] Verify Service enabled (SMS + email):', verifyServiceSid);
}

// Generate 6-digit OTP (used only when not using Twilio Verify)
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
      // Email OTP: send via Twilio Verify (channel: email)
      // Requires Email Integration in Twilio Console: https://www.twilio.com/console/verify/email
      if (!twilioClient || !verifyServiceSid) {
        return res.status(500).json({
          success: false,
          message:
            'Email service is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID in .env and configure Email Integration at twilio.com/console/verify/email'
        });
      }

      try {
        const verification = await twilioClient.verify.v2
          .services(verifyServiceSid)
          .verifications.create({
            to: identifier,
            channel: 'email'
          });

        // Create OTP record for rate limiting only (Verify handles the actual code)
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        await OTP.create({
          identifier,
          otp: 'verify',
          type,
          expiresAt
        });

        console.log(`[OTP] Verify email sent to ${identifier}, SID: ${verification.sid}`);
      } catch (twilioError) {
        console.error(
          '[OTP] Twilio Verify email error:',
          JSON.stringify({
            code: twilioError?.code,
            status: twilioError?.status,
            message: twilioError?.message
          })
        );
        let userMessage =
          twilioError?.message || 'Failed to send verification email. Please try again.';
        if (
          twilioError?.message?.toLowerCase().includes('email integration') ||
          twilioError?.code === 60200
        ) {
          userMessage =
            'Email verification is not configured. Set up Email Integration at twilio.com/console/verify/email (requires SendGrid).';
        }
        return res.status(500).json({
          success: false,
          message: userMessage
        });
      }
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

    // Both phone and email: verify via Twilio Verify API
    if (!twilioClient || !verifyServiceSid) {
      return res.status(500).json({
        success: false,
        message:
          'Verification service is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID in .env. For email OTP, also configure Email Integration at twilio.com/console/verify/email'
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
        message: 'Invalid or expired OTP. Please try again.'
      });
    }

    const provider = type === 'phone' ? 'phone' : 'email';
    const identifierField = type === 'phone' ? 'phone' : 'email';

    // Find or create user and sync login providers
    let user = await User.findOne({ [identifierField]: identifier });
    if (user) {
      if (!user.loginProviders.includes(provider)) {
        user.loginProviders.push(provider);
        await user.save();
      }
    } else {
      user = await User.create({
        [identifierField]: identifier,
        name: '',
        loginProviders: [provider]
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await AuthToken.create({ token, userId: user._id });

    res.json({
      success: true,
      message: 'OTP verified successfully',
      token,
      user: {
        id: user._id,
        name: user.name || '',
        phone: user.phone || '',
        email: user.email || '',
        loginProviders: user.loginProviders
      }
    });
  } catch (error) {
    console.error('[OTP] Verify error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP. Please try again.'
    });
  }
});

// POST /api/auth/google - Sign in / sign up with Google ID token
// Client sends { idToken: "..." } from Google Sign-In
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: 'Google ID token is required'
      });
    }

    if (!googleClientId) {
      return res.status(500).json({
        success: false,
        message:
          'Google Sign-In is not configured. Set GOOGLE_CLIENT_ID or Google_Client_ID in .env'
      });
    }

    const client = new OAuth2Client(googleClientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: googleClientId
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error('[Auth] Google token verification failed:', verifyError?.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired Google token. Please sign in again.'
      });
    }

    const googleId = payload.sub;
    const email = payload.email || null;
    const name = payload.name || payload.given_name || '';

    // Account linking: same user on phone (mobile) and Google (Mac)
    // 1. Find by googleId (already linked)
    // 2. Find by email (link - user previously signed up with phone/email)
    let user = await User.findOne({ googleId });
    if (!user && email) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = googleId;
        if (!user.loginProviders.includes('google')) {
          user.loginProviders.push('google');
        }
        if (name && !user.name) user.name = name;
        await user.save();
      }
    }
    if (!user) {
      user = await User.create({
        googleId,
        email: email || undefined,
        name,
        loginProviders: ['google']
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await AuthToken.create({ token, userId: user._id });

    res.json({
      success: true,
      message: 'Signed in with Google successfully',
      token,
      user: {
        id: user._id,
        name: user.name || '',
        phone: user.phone || '',
        email: user.email || '',
        loginProviders: user.loginProviders
      }
    });
  } catch (error) {
    console.error('[Auth] Google login error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sign in with Google. Please try again.'
    });
  }
});

// POST /api/auth/apple - Sign in / sign up with Apple
router.post('/apple', async (req, res) => {
  try {
    const { identityToken, name, email } = req.body;

    if (!identityToken) {
      return res.status(400).json({
        success: false,
        message:
          'Apple identity token is required. Integrate Sign in with Apple on the client first.'
      });
    }

    let payload;
    try {
      payload = await verifyAppleToken({
        idToken: identityToken,
        clientId: appleClientId
      });
    } catch (verifyError) {
      console.error('[Auth] Apple token verification failed:', verifyError?.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired Apple token. Please sign in again.'
      });
    }

    const appleId = payload.sub;
    const verifiedEmail = payload.email || email || null;

    // Find or create user and link Apple ID
    let user = await User.findOne({ appleId });
    if (!user && verifiedEmail) {
      user = await User.findOne({ email: verifiedEmail });
      if (user) {
        user.appleId = appleId;
        if (!user.loginProviders.includes('apple')) {
          user.loginProviders.push('apple');
        }
        if (name && !user.name) user.name = name;
        if (verifiedEmail && !user.email) user.email = verifiedEmail;
        await user.save();
      }
    }
    if (!user) {
      user = await User.create({
        appleId,
        email: verifiedEmail || undefined,
        name: name || '',
        loginProviders: ['apple']
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await AuthToken.create({ token, userId: user._id });

    res.json({
      success: true,
      message: 'Signed in with Apple successfully',
      token,
      user: {
        id: user._id,
        name: user.name || '',
        phone: user.phone || '',
        email: user.email || '',
        loginProviders: user.loginProviders
      }
    });
  } catch (error) {
    console.error('[Auth] Apple login error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sign in with Apple. Please try again.'
    });
  }
});

// POST /api/auth/delete-account - Permanently delete user account (requires Bearer token)
router.post('/delete-account', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authorization token required. Please sign in again.'
      });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization token.'
      });
    }

    const authToken = await AuthToken.findOne({ token });
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token. Please sign in again.'
      });
    }

    const userId = authToken.userId;
    await AuthToken.deleteMany({ userId });
    await User.findByIdAndDelete(userId);

    res.json({
      success: true,
      message: 'Account deleted successfully.'
    });
  } catch (error) {
    console.error('[Auth] Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete account. Please try again.'
    });
  }
});

module.exports = router;
