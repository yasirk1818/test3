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

const ADMIN_NUMBER = '923186385943'; // <-- YAHAN APNA KITCHEN/ADMIN KA NUMBER LIKHAIN
const menuPath = path.join(__dirname, 'menu.json');

const readMenu = () => JSON.parse(fs.readFileSync(menuPath));
const writeMenu = (data) => fs.writeFileSync(menuPath, JSON.stringify(data, null, 2));

const sessions = new Map();

// --- API & WEB ROUTES ---
app.get('/', (req, res) => res.sendFile('index.html', { root: __dirname }));
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: __dirname }));
app.get('/api/menu', (req, res) => res.json(readMenu()));
app.post('/api/category', (req, res) => { const { id, title } = req.body; const menu = readMenu(); if (!menu[id]) { menu[id] = { title, items: [] }; writeMenu(menu); res.status(201).send(); } else { res.status(400).send(); } });
app.post('/api/item', (req, res) => { const { categoryId, name, price } = req.body; const menu = readMenu(); if (menu[categoryId]) { const newItem = { id: `item_${Date.now()}`, name, price }; menu[categoryId].items.push(newItem); writeMenu(menu); res.status(201).send(); } else { res.status(404).send(); } });
app.delete('/api/item/:categoryId/:itemId', (req, res) => { const { categoryId, itemId } = req.params; const menu = readMenu(); if (menu[categoryId]) { menu[categoryId].items = menu[categoryId].items.filter(i => i.id !== itemId); writeMenu(menu); res.status(200).send(); } else { res.status(404).send(); } });
app.delete('/api/category/:categoryId', (req, res) => { const { categoryId } = req.params; const menu = readMenu(); if (menu[categoryId]) { delete menu[categoryId]; writeMenu(menu); res.status(200).send(); } else { res.status(404).send(); } });

// --- BOT HELPERS ---
const getMainMenu = () => new List('Please choose a category.', 'View Menu', [{ title: 'Main Categories', rows: Object.keys(readMenu()).map(key => ({ id: `cat_${key}`, title: readMenu()[key].title })) }], 'Hotel Bot Menu');
const getCategoryMenu = (key) => new List(`Items in ${readMenu()[key].title}`, 'View Items', [{ title: readMenu()[key].title, rows: readMenu()[key].items.map(i => ({ id: `item_${key}_${i.id}`, title: i.name, description: `Rs. ${i.price}` })) }], 'Items Menu');

const createSession = (sessionId) => {
    console.log(`Creating session: ${sessionId}`);
    const client = new Client({ authStrategy: new LocalAuth({ clientId: sessionId }), puppeteer: { headless: true, args: ['--no-sandbox'] } });

    client.on('qr', qr => qrcode.toDataURL(qr, (err, url) => io.to(sessionId).emit('qr', url)));
    client.on('ready', () => { io.to(sessionId).emit('status', `Connected! Send 'menu' to start.`); io.to(sessionId).emit('qr', null); });

    client.on('message', async (message) => {
        const chatId = message.from;
        const sessionData = sessions.get(sessionId);
        if (!sessionData || message.from.endsWith('@g.us') || message.fromMe) return;

        const lowerCaseText = message.body.toLowerCase();
        
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
            switch (sessionData.state) {
                case 'main_menu':
                case 'selecting_from_keyword':
                    const [_, cKey, iId] = message.selectedRowId.split('_');
                    const item = readMenu()[cKey]?.items.find(i => i.id === iId);
                    if (item) { sessionData.cart.push(item); sessionData.state = 'item_added'; await client.sendMessage(chatId, new Buttons(`Added ${item.name}.`, [{ body: 'Add More' }, { body: 'Checkout' }], 'What next?')); }
                    break;
                case 'item_added':
                    if (lowerCaseText === 'add more') { sessionData.state = 'main_menu'; await client.sendMessage(chatId, getMainMenu()); } 
                    else if (lowerCaseText === 'checkout') {
                        if (sessionData.cart.length === 0) { await client.sendMessage(chatId, "Your cart is empty. Please add items first."); return; }
                        sessionData.state = 'confirming_order';
                        let summary = 'Your Order:\n', total = 0;
                        sessionData.cart.forEach(i => { summary += `\n- ${i.name} (Rs. ${i.price})`; total += i.price; });
                        summary += `\n\n*Total: Rs. ${total}*`;
                        await client.sendMessage(chatId, new Buttons(summary, [{ body: 'Confirm Order' }, { body: 'Cancel' }], 'Please confirm.'));
                    }
                    break;
                case 'confirming_order':
                    if (lowerCaseText === 'confirm order') { sessionData.state = 'awaiting_address'; await client.sendMessage(chatId, 'Great! Please type your full delivery address.'); } 
                    else { sessionData.state = 'start'; sessionData.cart = []; await client.sendMessage(chatId, 'Order cancelled. Type "menu" to start again.'); }
                    break;
            }
        }
    });
    client.initialize();
    sessions.set(sessionId, { client, state: 'start', cart: [] });
};

io.on('connection', (socket) => {
    socket.on('create-session', () => { const sessionId = `session-${Date.now()}`; createSession(sessionId); socket.emit('session-created', sessionId); });
    socket.on('join-session', (sessionId) => { socket.join(sessionId); });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}. Admin: http://localhost:${PORT}/admin`));
