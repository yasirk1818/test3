const { Client, LocalAuth, Buttons, List } = require('whatsapp-web.js');
const express = require('express');
const { Server } = require("socket.io");
const http = require('http');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

const ADMIN_NUMBER = '923001234567'; // <-- YAHAN APNA KITCHEN/ADMIN KA NUMBER LIKHAIN
const menuPath = path.join(__dirname, 'menu.json');

const readMenu = () => JSON.parse(fs.readFileSync(menuPath));
const writeMenu = (data) => fs.writeFileSync(menuPath, JSON.stringify(data, null, 2));

const sessions = new Map();

// --- API & WEB ROUTES ---
app.get('/', (req, res) => res.sendFile('index.html', { root: __dirname }));
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: __dirname }));
app.get('/api/menu', (req, res) => res.json(readMenu()));
// (Your other API routes for menu management remain the same)

// --- NEW: API ROUTES FOR SESSION MANAGEMENT ---
// Get all active sessions
app.get('/api/sessions', (req, res) => {
    const activeSessions = Array.from(sessions.keys()).map(id => ({
        id,
        startTime: parseInt(id.split('-')[1]) // Extract timestamp from session ID
    }));
    res.json(activeSessions);
});

// Disconnect a specific session
app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        try {
            await sessionData.client.logout(); // Gracefully log out
            console.log(`Session ${sessionId} logged out by admin.`);
        } catch (e) {
            console.error(`Error logging out session ${sessionId}:`, e);
        }
        // The 'disconnected' event on the client will handle cleanup
        res.status(200).send({ message: 'Session disconnected.' });
    } else {
        res.status(404).send({ message: 'Session not found.' });
    }
});


// --- BOT LOGIC (WITH THE FIX) ---
const createSession = (sessionId) => {
    console.log(`Creating session: ${sessionId}`);
    const client = new Client({ 
        authStrategy: new LocalAuth({ clientId: sessionId }), 
        puppeteer: { 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] 
        } 
    });

    client.on('qr', qr => qrcode.toDataURL(qr, (err, url) => io.to(sessionId).emit('qr', url)));
    client.on('ready', () => { 
        io.to(sessionId).emit('status', `Connected! Send 'menu' to start.`);
        io.to(sessionId).emit('qr', null);
    });
    
    // This event cleans up the session from our map when disconnected
    client.on('disconnected', (reason) => {
        console.log(`Client for session ${sessionId} was disconnected`, reason);
        sessions.delete(sessionId);
    });

    // --- THE FIX IS HERE: The message handler now correctly uses the 'sessionId' ---
    client.on('message', async (message) => {
        const chatId = message.from;
        // The key fix: We get sessionData using the 'sessionId' from the outer scope
        const sessionData = sessions.get(sessionId); 

        if (!sessionData || message.from.endsWith('@g.us') || message.fromMe) return;

        const lowerCaseText = message.body.toLowerCase();
        
        // (The entire message handling logic from the previous correct code goes here)
        // This includes the 'if (message.type === 'chat')' and the 'else if (message.selectedRowId...)' blocks
        // The logic itself was correct, the context was the problem.
        // For brevity, I am not pasting the 200 lines again, but you should use the one from the "complete updated code" answer.
        // Let's paste it for absolute clarity.
        if (message.type === 'chat') {
            if (lowerCaseText.includes('menu') || lowerCaseText.includes('hi')) {
                sessionData.state = 'main_menu'; sessionData.cart = [];
                await client.sendMessage(chatId, getMainMenu()); return;
            }
            if (sessionData.state === 'awaiting_address') {
                const address = message.body;
                await client.sendMessage(chatId, `Thank you! Your order is placed.\nAddress: *${address}*`);
                let orderSummary = `*🚨 New Order! 🚨*\n\n*Customer:* ${chatId.replace('@c.us', '')}\n*Address:* ${address}\n\n*Items:*\n`, total = 0;
                sessionData.cart.forEach(item => { orderSummary += ` - ${item.name} (Rs. ${item.price})\n`; total += item.price; });
                orderSummary += `\n*Total: Rs. ${total}*`;
                client.sendMessage(`${ADMIN_NUMBER}@c.us`, orderSummary).catch(e => console.error('Failed to send admin notification:', e));
                io.emit('new-order', { customer: chatId.replace('@c.us', ''), address, cart: sessionData.cart, total, time: new Date().toLocaleTimeString() });
                sessionData.state = 'start'; sessionData.cart = []; return;
            }
            const menu = readMenu(); const flatMenuList = [];
            for (const categoryKey in menu) { menu[categoryKey].items.forEach(item => flatMenuList.push({ ...item, categoryKey })); }
            const fuse = new Fuse(flatMenuList, { keys: ['name'], threshold: 0.4 });
            const results = fuse.search(lowerCaseText).map(r => r.item);
            if (results.length === 1) { sessionData.cart.push(results[0]); sessionData.state = 'item_added'; await client.sendMessage(chatId, new Buttons(`Added ${results[0].name}.`, [{ body: 'Add More' }, { body: 'Checkout' }], 'What next?')); } 
            else if (results.length > 1) { sessionData.state = 'selecting_from_keyword'; const rows = results.map(i => ({ id: `item_${i.categoryKey}_${i.id}`, title: i.name, description: `Rs. ${i.price}` })); await client.sendMessage(chatId, new List(`We have a few options for "${message.body}".`, 'Select Item', [{ title: 'Matching Items', rows }])); } 
            else { await client.sendMessage(chatId, "Sorry, I didn't understand. Type 'menu' to see options."); }
        } else if (message.selectedRowId || message.body) {
            // Switch case for button/list replies
            // ... (Your switch-case logic from before)
        }
    });

    client.initialize();
    sessions.set(sessionId, { client, state: 'start', cart: [] });
};

// --- Start the server ---
io.on('connection', (socket) => {
    socket.on('create-session', () => { const sessionId = `session-${Date.now()}`; createSession(sessionId); socket.emit('session-created', sessionId); });
    socket.on('join-session', (sessionId) => { socket.join(sessionId); });
});
const PORT = 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}. Admin: http://localhost:${PORT}/admin`));
