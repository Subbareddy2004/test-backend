const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const geolib = require('geolib');
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Allow all origins
app.use(cors());
app.use(bodyParser.json());

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define User Schema
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    homeAddress: { type: String, required: true },
    workAddress: String,
    isWorker: { type: Boolean, default: false }
});

const User = mongoose.model('User', UserSchema);

// Define Order Schema
const OrderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    items: [{ 
        productId: String,
        productTitle: String,
        quantity: Number,
        price: Number
    }],
    totalPrice: Number,
    deliveryAddress: String,
    phoneNumber: String,
    createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', OrderSchema);

// User registration
app.post('/api/signup', async (req, res) => {
    try {
        const { username, password, homeAddress, workAddress, isWorker } = req.body;
        const hashedPassword = await bcrypt.hash(password, 8);
        const user = new User({
            username,
            password: hashedPassword,
            homeAddress,
            workAddress,
            isWorker
        });
        await user.save();
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.status(201).send({ auth: true, token, user: { id: user._id, username: user.username } });
    } catch (error) {
        res.status(500).send({ error: 'Error registering user' });
    }
});

// User login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ message: 'User not found' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.json({
            user: {
                _id: user._id,
                username: user.username,
            },
            token
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get user profile
app.get('/api/users/me', async (req, res) => {
    try {
        const user = await User.findById(req.query.userId).select('-password');
        if (!user) return res.status(404).send('User not found');
        res.status(200).send(user);
    } catch (error) {
        res.status(500).send({ error: 'Error fetching user profile' });
    }
});

// Update user profile
app.put('/api/users/:id', async (req, res) => {
    try {
        const { username, homeAddress, workAddress } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, 
            { username, homeAddress, workAddress },
            { new: true }
        ).select('-password');
        res.status(200).send(user);
    } catch (error) {
        res.status(500).send({ error: 'Error updating user profile' });
    }
});

// Create a new order
app.post('/api/orders', async (req, res) => {
    try {
      const { userId, items, totalPrice, deliveryAddress, phoneNumber, paymentMethod } = req.body;
      const newOrder = new Order({
        userId,
        items,
        totalPrice,
        deliveryAddress,
        phoneNumber,
        paymentMethod
      });
      await newOrder.save();
      res.status(201).json(newOrder);
    } catch (error) {
      console.error('Error creating order:', error);
      res.status(500).json({ message: 'Error creating order' });
    }
});

// Get user's order history
app.get('/api/orders/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }
      const orders = await Order.find({ userId });
      res.json(orders);
    } catch (error) {
      console.error('Error fetching orders:', error);
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message, mealType, userLocation } = req.body;

        if (!message && !mealType) {
            return res.status(400).json({ error: 'Message or meal type is required' });
        }

        const menuSnapshot = await db.collection('fs_food_items1').get();
        const menu = menuSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const recommendations = await getPersonalizedRecommendations(message, menu, mealType, userLocation);

        res.json({
            recommendations: recommendations
        });
    } catch (error) {
        console.error("Error processing chat:", error);
        res.status(500).json({ 
            error: "An error occurred while processing the chat.",
            details: error.message
        });
    }
});

async function addHotelInfoAndDistance(items, userLocation) {
    return await Promise.all(items.map(async item => {
        const hotelDoc = await db.collection('fs_hotels').doc(item.productOwnership).get();
        const hotelData = hotelDoc.exists ? hotelDoc.data() : null;

        let distance = null;
        if (hotelData && hotelData.latitude && hotelData.longitude && 
            userLocation && userLocation.latitude && userLocation.longitude) {
            try {
                distance = geolib.getDistance(
                    { latitude: parseFloat(userLocation.latitude), longitude: parseFloat(userLocation.longitude) },
                    { latitude: parseFloat(hotelData.latitude), longitude: parseFloat(hotelData.longitude) }
                ) / 1000;
            } catch (error) {
                console.error("Error calculating distance:", error);
            }
        }

        return {
            ...item,
            hotelName: hotelData ? hotelData.hotelName : item.productOwnership,
            distance: distance !== null ? Number(distance.toFixed(2)) : null
        };
    }));
}

async function getPersonalizedRecommendations(query, menu, mealType, userLocation) {
    try {
        if (query) {
            const exactMatches = menu.filter(item => 
                item.productTitle.toLowerCase().includes(query.toLowerCase())
            );

            if (exactMatches.length > 0) {
                return exactMatches.slice(0, 5);
            }
        }

        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        let prompt = `You are an AI assistant for a food ordering platform. `;
        
        prompt += `Given the following menu items: ${JSON.stringify(menu)}, `;
        
        if (query) {
            prompt += `provide a list of up to 5 recommended items that closely match the user's search query: "${query}". Prioritize items that contain the query words. `;
        } else if (mealType) {
            prompt += `provide a list of 5 recommended ${mealType} items. `;
        } else {
            prompt += `provide a list of 5 generally recommended items. `;
        }
        
        prompt += `Format the response as a JSON array of objects with 'id' and 'relevance' properties, where 'relevance' is a number from 0 to 1 indicating how closely the item matches the query or meal type. Do not include any additional text or formatting.`;

        const result = await model.generateContent(prompt);
        const content = result.response.text();
        console.log("Raw Gemini response for recommendations:", content);

        const jsonContent = content.replace(/^[\s\S]*?(\[[\s\S]*\])[\s\S]*$/, '$1');

        let recommendedItems;
        try {
            recommendedItems = JSON.parse(jsonContent);
        } catch (parseError) {
            console.error("Error parsing Gemini response:", parseError);
            return [];
        }

        recommendedItems.sort((a, b) => b.relevance - a.relevance);

        const recommendations = await Promise.all(recommendedItems.map(async item => {
            const menuItem = menu.find(m => m.id === item.id);
            if (!menuItem) return null;

            const hotelDoc = await db.collection('fs_hotels').doc(menuItem.productOwnership).get();
            const hotelData = hotelDoc.exists ? hotelDoc.data() : null;

            let distance = null;
            if (hotelData && hotelData.latitude && hotelData.longitude && 
                userLocation && userLocation.latitude && userLocation.longitude) {
                try {
                    distance = geolib.getDistance(
                        { latitude: parseFloat(userLocation.latitude), longitude: parseFloat(userLocation.longitude) },
                        { latitude: parseFloat(hotelData.latitude), longitude: parseFloat(hotelData.longitude) }
                    ) / 1000;
                } catch (error) {
                    console.error("Error calculating distance:", error);
                }
            }

            return {
                ...menuItem,
                hotelName: hotelData ? hotelData.hotelName : menuItem.productOwnership,
                distance: distance !== null ? Number(distance.toFixed(2)) : null
            };
        }));

        console.log("Recommendations with distance:", recommendations);

        return recommendations.filter(Boolean);
    } catch (error) {
        console.error("Error getting personalized recommendations:", error);
        return [];
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

app.get('/api/recommendations', async (req, res) => {
    try {
        const recommendationsSnapshot = await db.collection('recommendations').limit(5).get();
        const recommendations = recommendationsSnapshot.docs.map(doc => doc.data());
        res.json(recommendations);
    } catch (error) {
        console.error("Error fetching recommendations:", error);
        res.status(500).json({ error: "Failed to fetch recommendations" });
    }
});

app.get('/api/popular-items', async (req, res) => {
    try {
        const popularItemsSnapshot = await db.collection('fs_food_items1')
        .where('productRating', '>=', 4.0)
            .orderBy('productRating', 'desc')
            .limit(5)
            .get();
        const popularItems = popularItemsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        res.json(popularItems);
    } catch (error) {
        console.error("Error fetching popular items:", error);
        res.status(500).json({ error: "Failed to fetch popular items" });
    }
});

app.get('/api/personalized-recommendations', async (req, res) => {
    try {
        const { query, mealType, latitude, longitude, timestamp } = req.query;
        console.log('Received request with query:', query, 'mealType:', mealType, 'lat:', latitude, 'lon:', longitude, 'timestamp:', timestamp);
        
        const menuSnapshot = await db.collection('fs_food_items1').get();
        const menu = menuSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log('Total menu items:', menu.length);
        
        let recommendations = [];

        if (query) {
            recommendations = menu.filter(item => 
                item.productTitle.toLowerCase().includes(query.toLowerCase()) ||
                (item.productDesc && item.productDesc.toLowerCase().includes(query.toLowerCase()))
            );
        } else if (mealType) {
            recommendations = menu.filter(item => 
                item.foodAvailTime && item.foodAvailTime.toLowerCase() === mealType.toLowerCase()
            );
            recommendations = shuffleArray(recommendations).slice(0, 5);
        }

        console.log('Filtered recommendations:', recommendations.length);

        if (recommendations.length === 0) {
            recommendations = shuffleArray(menu).slice(0, 5);
            console.log('No matches found, returning random items');
        }

        const userLocation = latitude && longitude ? { latitude, longitude } : null;
        recommendations = await addHotelInfoAndDistance(recommendations, userLocation);

        console.log('Sending recommendations:', recommendations.map(item => item.productTitle));
        res.json(recommendations);
    } catch (error) {
        console.error("Error fetching personalized recommendations:", error);
        res.status(500).json({ error: "Failed to fetch personalized recommendations", details: error.message });
    }
});
app.get('/api/nearby-hotels', async (req, res) => {
    try {
      const { latitude, longitude } = req.query;
      
      const hotelsSnapshot = await db.collection('fs_hotels').get();
      const hotels = hotelsSnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(hotel => hotel.latitude && hotel.longitude);
      
      const nearbyHotels = hotels.map(hotel => {
        try {
          const distance = geolib.getDistance(
            { latitude: parseFloat(latitude), longitude: parseFloat(longitude) },
            { latitude: parseFloat(hotel.latitude), longitude: parseFloat(hotel.longitude) }
          ) / 1000;
          return { 
            id: hotel.id,
            name: hotel.hotelName || 'Unnamed Hotel',
            address: hotel.hotelAddress || 'Address not available',
            phone: hotel.hotelPhoneNo || 'Phone not available',
            type: hotel.hotelType || 'restaurant',
            latitude: hotel.latitude,
            longitude: hotel.longitude,
            distance
          };
        } catch (error) {
          console.error(`Error calculating distance for hotel ${hotel.id}:`, error);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
      
      res.json(nearbyHotels);
    } catch (error) {
      console.error("Error fetching nearby hotels:", error);
      res.status(500).json({ error: "Failed to fetch nearby hotels" });
    }
  });
  
  if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  }
  
  module.exports = app;