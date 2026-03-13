# Time Boxed Authentication Backend

Node.js backend API for sending OTP emails and verifying OTP codes.

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure OTP

**Phone (SMS) OTP:** Uses [Twilio Verify](https://www.twilio.com/docs/verify). Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`.

**Email OTP:** Uses [Resend](https://resend.com). Sign up at resend.com, create an API key, add `RESEND_API_KEY` to .env.

### 3. Create .env File

Create a `.env` file in the backend root and add:

```env
PORT=3000

# Twilio Verify (for phone/SMS OTP)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_VERIFY_SERVICE_SID=VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Resend (for email OTP)
RESEND_API_KEY=re_your_api_key_here

# MongoDB (required for NFC and user persistence)
MONGO_URI=mongodb://localhost:27017/timeboxed

# JWT secret (required when using MongoDB; use a long random string in production)
JWT_SECRET=your-long-random-secret-here

# Admin secret for adding NFC tags to DB (optional; required for POST /api/nfc/admin/add)
ADMIN_SECRET=your-admin-secret-here
```

**Important:** 
- Twilio: required for phone OTP. Resend: required for email OTP
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

- ✅ Sends OTP via Twilio (SMS) and Resend (email)
- ✅ 6-digit OTP generation
- ✅ 5-minute expiration
- ✅ Rate limiting (3 requests per email per hour)
- ✅ Automatic cleanup of expired OTPs
- ✅ CORS enabled for iOS app
- ✅ Error handling
