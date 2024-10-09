const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, required: true, enum: ['farmer', 'buyer'] },
  
  location: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true }
  },

  socialMedia: {
    instagram: { type: String },
    facebook: { type: String },
    tiktok: { type: String }
  },
  description: { type: String },
  products: [
    {
      name: { type: String, required: true },
      description: { type: String },
      price: { type: Number, required: true }
    }
  ],

  partners: [
    {
      name: { type: String, required: true },
      location: { type: String, required: true },
      description: { type: String }
    }
  ],

  wholesaleAvailable: { type: Boolean, default: false }
});

module.exports = mongoose.model('User', UserSchema);
