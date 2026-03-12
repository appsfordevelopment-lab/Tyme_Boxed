# Time Boxed Authentication Backend

Node.js backend API for sending OTP emails and verifying OTP codes.

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Twilio Verify (SMS + Email OTP)

Both phone and email OTP use [Twilio Verify](https://www.twilio.com/docs/verify). Use your existing Twilio account:

**SMS (phone) OTP:** Works with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID`.

**Email OTP:** Requires an additional Email Integration in Twilio Console:
1. Go to [twilio.com/console/verify/email](https://www.twilio.com/console/verify/email)
2. Create an email integration (requires [SendGrid](https://sendgrid.com) account + API key + Dynamic Template with `{{twilio_code}}`)
3. Connect the integration to your Verify service

See [Twilio Verify Email setup](https://www.twilio.com/docs/verify/email) for full instructions.

### 3. Create .env File

Create a `.env` file in the backend root and add:

```env
PORT=3000

# Twilio Verify (required for both SMS and email OTP)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_VERIFY_SERVICE_SID=VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# MongoDB (required for NFC and user persistence)
MONGO_URI=mongodb://localhost:27017/timeboxed

# JWT secret (required when using MongoDB; use a long random string in production)
JWT_SECRET=your-long-random-secret-here

# Admin secret for adding NFC tags to DB (optional; required for POST /api/nfc/admin/add)
ADMIN_SECRET=your-admin-secret-here
```

**Important:** 
- Twilio credentials are **required** for OTP (both phone and email)
- For email OTP, you must also configure the Email Integration in Twilio Console (SendGrid + template)
- Never commit the `.env` file to git

### 4. Start the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on `http://localhost:3000`



**NFC (tags are pre-saved in DB; user does not register):**

Add a tag to DB (admin; set ADMIN_SECRET in .env):
```bash
curl -X POST http://localhost:3000/api/nfc/admin/add \
  -H "Content-Type: application/json" \
 
  -d '{"tagId":"nfc-tag-identifier-123"}'
```

Verify scanned tag (login not required):
```bash
curl -X POST http://localhost:3000/api/nfc/verify \
  -H "Content-Type: application/json" \
  -d '{"tagId":"nfc-tag-identifier-123"}'
```
Response: `{ "success": true, "valid": true }` or `{ "success": true, "valid": false }`. See `NFC_SETUP.md` for full flow.

## API Endpoints

### POST `/api/auth/send-otp`

Sends a 6-digit OTP to the specified email address.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "expiresIn": 300
}
```

### POST `/api/auth/verify-otp`

Verifies the OTP code.

**Request:**
```json
{
  "email": "user@example.com",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP verified successfully",
  "token": "base64-encoded-token"
}
```

## Features

- ✅ Sends OTP via Twilio Verify (SMS and email)
- ✅ 6-digit OTP generation
- ✅ 5-minute expiration
- ✅ Rate limiting (3 requests per email per hour)
- ✅ Automatic cleanup of expired OTPs
- ✅ CORS enabled for iOS app
- ✅ Error handling
