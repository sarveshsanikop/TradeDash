const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- MONGODB CONNECTION ---
mongoose.connect('mongodb://127.0.0.1:27017/stockDashboard')
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- STRICT SCHEMA ---
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    subscriptions: [{
        symbol: String,
        entryPrice: Number
    }]
});
const User = mongoose.model('User', userSchema);

// --- HELPER: EMAIL VALIDATION ---
function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// --- STOCK ENGINE (REALISTIC BASE PRICES) ---
const STOCK_BASE_PRICES = {
    'GOOG': 175.50,
    'TSLA': 342.20,
    'AMZN': 202.10,
    'META': 595.00,
    'NVDA': 138.80
};
const STOCKS = Object.keys(STOCK_BASE_PRICES);

let currentPrices = {};
let stockHistory = {}; 

// Initialize Stocks
STOCKS.forEach(stock => {
    const basePrice = STOCK_BASE_PRICES[stock];
    currentPrices[stock] = basePrice.toFixed(2);
    stockHistory[stock] = [];

    // Generate stable history around base price
    let tempPrice = basePrice;
    for(let i = 100; i > 0; i--) {
        const volatility = (Math.random() - 0.5) * 0.8; // Small fluctuation
        const pull = (basePrice - tempPrice) * 0.05; // Gentle pull to base
        tempPrice += volatility + pull;
        
        stockHistory[stock].push({
            price: tempPrice.toFixed(2),
            timestamp: new Date(Date.now() - (i * 3000)).toLocaleTimeString()
        });
    }
    currentPrices[stock] = tempPrice.toFixed(2);
});

// Update Loop (Stable Movement)
setInterval(() => {
    STOCKS.forEach(stockCode => {
        const current = parseFloat(currentPrices[stockCode]);
        const base = STOCK_BASE_PRICES[stockCode];

        // Small random noise (-0.20 to +0.20)
        const noise = (Math.random() * 0.4) - 0.2;
        
        // Stability Logic: Pull back to base if drifting too far
        const pull = (base - current) * 0.02; 

        let newPrice = current + noise + pull;
        if(newPrice < 10) newPrice = 10;
        
        currentPrices[stockCode] = newPrice.toFixed(2);

        const dataPoint = {
            code: stockCode,
            price: currentPrices[stockCode],
            timestamp: new Date().toLocaleTimeString()
        };

        stockHistory[stockCode].push(dataPoint);
        if(stockHistory[stockCode].length > 100) stockHistory[stockCode].shift();

        io.to(stockCode).emit('priceUpdate', dataPoint);
    });
}, 3000);

// --- SOCKET CONTROLLER ---
io.on('connection', (socket) => {
    
    // 1. REGISTER
    socket.on('register', async ({ name, email, password }) => {
        try {
            if(!name || !email || !password || password.length < 4) {
                return socket.emit('authError', 'Invalid details. Name required, Pass > 3 chars.');
            }
            if (!isValidEmail(email)) {
                return socket.emit('authError', 'Invalid email format. Use name@domain.com');
            }

            const existingUser = await User.findOne({ email });
            if (existingUser) return socket.emit('authError', 'Email exists.');
            
            const hashedPassword = await bcrypt.hash(password, 10);
            await User.create({ name, email, password: hashedPassword, subscriptions: [] });
            socket.emit('registerSuccess', 'Registration successful!');
        } catch (err) { socket.emit('authError', 'Registration failed.'); }
    });

    // 2. LOGIN (WITH AUTO-CORRECT FOR OLD DATA)
    socket.on('login', async ({ email, password }) => {
        try {
            const user = await User.findOne({ email });
            if (!user) return socket.emit('authError', 'User not found.');
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) return socket.emit('authError', 'Invalid password.');

            socket.userEmail = user.email;

            let cleanSubs = [];
            
            if (user.subscriptions && Array.isArray(user.subscriptions)) {
                user.subscriptions.forEach(sub => {
                    if (sub && sub.symbol && STOCKS.includes(sub.symbol)) {
                        
                        // --- SANITY CHECK ---
                        // If stored Entry Price is wildly different from Current Price (Old Data),
                        // use Current Price instead.
                        const currentP = parseFloat(currentPrices[sub.symbol]);
                        let entryP = sub.entryPrice;

                        // If difference is > 20%, it's likely junk data from previous runs
                        if (!entryP || Math.abs(entryP - currentP) > (currentP * 0.2)) {
                            entryP = currentP; 
                        }

                        cleanSubs.push({
                            symbol: sub.symbol,
                            entryPrice: entryP
                        });
                    }
                });
            }

            // Restore rooms
            cleanSubs.forEach(sub => {
                socket.join(sub.symbol);
                socket.emit('loadHistory', { code: sub.symbol, history: stockHistory[sub.symbol] });
            });

            socket.emit('loginSuccess', {
                name: user.name,
                email: user.email,
                savedSubscriptions: cleanSubs,
                availableStocks: STOCKS
            });
        } catch (err) { 
            console.error(err);
            socket.emit('authError', 'Login failed.'); 
        }
    });

    // 3. UNSUBSCRIBE ALL
    socket.on('unsubscribeAll', ({ stocks }) => {
        if(!socket.userEmail) return; 
        if (Array.isArray(stocks)) {
            stocks.forEach(s => {
                try { socket.leave(s); } catch(e) {}
            });
        }
    });

    // 4. SUBSCRIBE (Saves to DB)
    socket.on('subscribe', async ({ stockCode }) => {
        if (!socket.userEmail) return socket.emit('authError', 'Session expired. Relogin.');
        if (!STOCKS.includes(stockCode)) return;

        socket.join(stockCode);
        const priceNow = parseFloat(currentPrices[stockCode]);

        try {
            console.log(`[DB] Subscribing ${socket.userEmail} to ${stockCode}`);
            
            await User.updateOne(
                { email: socket.userEmail },
                { $pull: { subscriptions: { symbol: stockCode } } }
            );
            await User.updateOne(
                { email: socket.userEmail },
                { $push: { subscriptions: { symbol: stockCode, entryPrice: priceNow } } }
            );
        } catch(err) {
            console.error('Subscribe Error:', err);
        }

        socket.emit('loadHistory', { code: stockCode, history: stockHistory[stockCode] });
    });

    // 5. UNSUBSCRIBE (Removes from DB)
    socket.on('unsubscribe', async ({ stockCode }) => {
        if (!socket.userEmail) return;

        socket.leave(stockCode);
        
        try {
            console.log(`[DB] Unsubscribing ${socket.userEmail} from ${stockCode}`);
            await User.updateOne(
                { email: socket.userEmail },
                { $pull: { subscriptions: { symbol: stockCode } } }
            );
        } catch(err) {
            console.error('Unsubscribe Error:', err);
        }
    });

    // 6. JOIN FEED (Read-Only)
    socket.on('joinFeed', ({ stockCode }) => {
        if (STOCKS.includes(stockCode)) {
            socket.join(stockCode);
        }
    });

    // 7. DISCONNECT
    socket.on('disconnect', (reason) => { });
});

const PORT = 3001; // Changed to 3001
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});