const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: ''
    },
    phone: {
      type: String,
      unique: true,
      sparse: true
    },
    email: {
      type: String,
      unique: true,
      sparse: true
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true
    },
    appleId: {
      type: String,
      unique: true,
      sparse: true
    },
    loginProviders: [
      {
        type: String,
        enum: ['phone', 'email', 'google', 'apple']
      }
    ],
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

// Indexes for fast lookups by provider identifiers
UserSchema.index({ phone: 1 }, { sparse: true });
UserSchema.index({ email: 1 }, { sparse: true });
UserSchema.index({ googleId: 1 }, { sparse: true });
UserSchema.index({ appleId: 1 }, { sparse: true });

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
