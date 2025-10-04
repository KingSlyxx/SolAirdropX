// server.js (სრული, განახლებული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// Express კონფიგურაცია
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

const PRODUCTS_FILE_PATH = path.join(__dirname, 'products.json');
const ORDERS_FILE_PATH = path.join(__dirname, 'orders.json');
const SITE_ASSETS_FILE_PATH = path.join(__dirname, 'site_assets.json'); // ახალი ფაილი

// --- ჩატის სესიების მართვის ობიექტები ---
const liveChatSessions = {};
const activeChats = {};
const operatorSelection = {};
const userState = {};

// --- ფაილთან მუშაობის ასინქრონული ფუნქციები ---
const readFileData = async (filePath, defaultData = '{}') => {
    try {
        await fs.access(filePath);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data || defaultData);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(filePath, defaultData, 'utf8');
            return JSON.parse(defaultData);
        }
        console.error(`Error reading file ${filePath}:`, error);
        throw error;
    }
};

const writeFileData = async (filePath, data) => {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
};

// =================================================================
// 1. ადმინისტრატორის ბოტის ლოგიკა
// =================================================================
let adminBot;
if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');

    const mainMenuKeyboard = {
        keyboard: [
            [{ text: 'პროდუქტების ნახვა' }],
            [{ text: 'პროდუქტის დამატება' }],
            [{ text: 'ხარისხის ფოტოების განახლება' }] // ახალი ღილაკი
        ],
        resize_keyboard: true,
    };

    const resetState = (chatId) => delete userState[chatId];

    adminBot.onText(/\/start/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
    });

    adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
        const products = await readFileData(PRODUCTS_FILE_PATH, '[]');
        if (!products || products.length === 0) {
            return adminBot.sendMessage(msg.chat.id, "პროდუქტები არ არის დამატებული.");
        }
        await adminBot.sendMessage(msg.chat.id, "პროდუქტების სია:");
        for (const p of products) {
            const caption = `ID: ${p.id}\nსახელი: ${p.name.ge}\nფასი: ₾${p.price}${p.oldPrice ? ` (ძველი: ₾${p.oldPrice})` : ''}`;
            const inlineKeyboard = {
                inline_keyboard: [[
                    { text: 'რედაქტირება', callback_data: `edit_${p.id}` },
                    { text: 'წაშლა', callback_data: `delete_${p.id}` }
                ]]
            };
            if (p.imageUrls && p.imageUrls.length > 0) {
                try {
                    await adminBot.sendPhoto(msg.chat.id, p.imageUrls[0], { caption, reply_markup: inlineKeyboard });
                } catch (e) {
                    await adminBot.sendMessage(msg.chat.id, `სურათის ჩატვირთვის შეცდომა.\n${caption}`, { reply_markup: inlineKeyboard });
                }
            } else {
                await adminBot.sendMessage(msg.chat.id, caption, { reply_markup: inlineKeyboard });
            }
        }
    });

    adminBot.onText(/პროდუქტის დამატება/, (msg) => {
        userState[msg.chat.id] = { step: 'awaiting_name_ge', product: { name: {}, description: {}, imageUrls: [] } };
        adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
    });

    // --- ახალი ფუნქცია ხარისხის ფოტოებისთვის ---
    adminBot.onText(/ხარისხის ფოტოების განახლება/, (msg) => {
        userState[msg.chat.id] = { step: 'awaiting_qc_images', qcImageUrls: [] };
        adminBot.sendMessage(msg.chat.id, 'ატვირთეთ ხარისხის შემოწმების ახალი ფოტოები სათითაოდ. დასრულების შემდეგ, დაწერეთ \'done\'. ძველი ფოტოები წაიშლება.');
    });

    adminBot.on('callback_query', async (cb) => {
        // (This part remains the same)
        const msg = cb.message;
        const data = cb.data;
        const [action, ...params] = data.split('_');
        const productId = parseInt(params[0]);

        switch (action) {
            case 'delete':
                adminBot.sendMessage(msg.chat.id, `დარწმუნებული ხართ, რომ გსურთ პროდუქტის (ID: ${productId}) წაშლა?`, {
                    reply_markup: { inline_keyboard: [[{ text: 'კი', callback_data: `confirm-delete_${productId}` }, { text: 'არა', callback_data: 'cancel-delete' }]] }
                });
                break;
            case 'confirm-delete':
                const products = await readFileData(PRODUCTS_FILE_PATH, '[]');
                const updatedProducts = products.filter(p => p.id !== productId);
                await writeFileData(PRODUCTS_FILE_PATH, updatedProducts);
                adminBot.editMessageText(`პროდუქტი (ID: ${productId}) წარმატებით წაიშალა.`, { chat_id: msg.chat.id, message_id: msg.message_id });
                break;
            case 'cancel-delete':
                adminBot.editMessageText('წაშლა გაუქმდა.', { chat_id: msg.chat.id, message_id: msg.message_id });
                break;
            case 'edit':
                 userState[msg.chat.id] = { step: 'editing_product', productId };
                adminBot.sendMessage(msg.chat.id, `აირჩიეთ რისი რედაქტირება გსურთ (ID: ${productId})`, {
                    reply_markup: { inline_keyboard: [
                        [{ text: 'სახელი (GE)', callback_data: `edit-field_name_ge_${productId}` }, { text: 'სახელი (EN)', callback_data: `edit-field_name_en_${productId}` }],
                        [{ text: 'ფასი', callback_data: `edit-field_price_${productId}` }, { text: 'ძვ. ფასი', callback_data: `edit-field_oldPrice_${productId}` }],
                        [{ text: 'აღწერა (GE)', callback_data: `edit-field_description_ge_${productId}`}, { text: 'აღწერა (EN)', callback_data: `edit-field_description_en_${productId}` }],
                        [{ text: 'ზომები', callback_data: `edit-field_sizes_${productId}` }, { text: 'სურათები (გადაწერა)', callback_data: `edit-field_imageUrls_${productId}` }]
                    ]}
                });
                break;
            case 'edit-field':
                const [field, subfield, prodId] = params;
                if (field === 'imageUrls') {
                     userState[msg.chat.id] = { step: 'awaiting_edit_images', productId: parseInt(prodId), newImageUrls: [] };
                     adminBot.sendMessage(msg.chat.id, `ატვირთეთ ახალი ფოტო(ები) პროდუქტისთვის (ID: ${prodId}). ძველი ფოტოები წაიშლება. დასრულების შემდეგ, დაწერეთ 'done'.`);
                } else {
                    userState[msg.chat.id] = { step: 'awaiting_edit_value', productId: parseInt(prodId), field, subfield };
                    adminBot.sendMessage(msg.chat.id, `შეიყვანეთ ახალი მნიშვნელობა ველისთვის "${field} ${subfield || ''}":`, { reply_markup: { force_reply: true } });
                }
                break;
        }
        adminBot.answerCallbackQuery(cb.id);
    });

    adminBot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const state = userState[chatId];
        
        // განახლებული ლოგიკა, რომელიც ამოწმებს ხარისხის ფოტოების მდგომარეობასაც
        if (!state || !['awaiting_images', 'awaiting_edit_images', 'awaiting_qc_images'].includes(state.step)) return;
        
        if (!IMGBB_API_KEY) {
            return adminBot.sendMessage(chatId, 'imgbb.com API გასაღები არ არის მითითებული სერვერზე.');
        }

        try {
            await adminBot.sendMessage(chatId, 'ფოტოს დამუშავება, გთხოვთ მოიცადოთ...');
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await adminBot.getFileLink(fileId);

            const imageResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(imageResponse.data, 'binary');

            const form = new FormData();
            form.append('image', imageBuffer, { filename: 'telegram_photo.jpg' });

            const uploadResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, {
                headers: form.getHeaders(),
            });

            if (uploadResponse.data.success) {
                const imageUrl = uploadResponse.data.data.url;
                if (state.step === 'awaiting_images') {
                   state.product.imageUrls.push(imageUrl);
                } else if (state.step === 'awaiting_edit_images'){
                   state.newImageUrls.push(imageUrl);
                } else if (state.step === 'awaiting_qc_images') { // ახალი ლოგიკა
                   state.qcImageUrls.push(imageUrl);
                }
                await adminBot.sendMessage(chatId, `ფოტო წარმატებით აიტვირთა. გამოაგზავნეთ შემდეგი ან დაწერეთ 'done'.`);
            } else {
                throw new Error(uploadResponse.data.error.message);
            }
        } catch (e) {
            console.error('Image upload failed:', e);
            await adminBot.sendMessage(chatId, `ფოტოს ატვირთვა ვერ მოხერხდა: ${e.message}`);
        }
    });

    adminBot.on('message', async (msg) => {
        const commandText = ['პროდუქტების ნახვა', 'პროდუქტის დამატება', 'ხარისხის ფოტოების განახლება'];
        if (!msg.text || msg.text.startsWith('/') || commandText.includes(msg.text)) return;
        
        const state = userState[msg.chat.id];
        if (!state) return;

        try {
            switch (state.step) {
                // ADD PRODUCT FLOW (იგივე რჩება)
                case 'awaiting_name_ge':
                    state.product.name.ge = msg.text;
                    state.step = 'awaiting_name_en';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ინგლისურად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_name_en':
                    state.product.name.en = msg.text;
                    state.step = 'awaiting_price';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ფასი (მაგ: 129.99):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_price':
                    state.product.price = parseFloat(msg.text).toFixed(2);
                    state.step = 'awaiting_old_price';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ძველი ფასი (თუ არ აქვს, დაწერეთ 0):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_old_price':
                    state.product.oldPrice = parseFloat(msg.text) > 0 ? parseFloat(msg.text).toFixed(2) : null;
                    state.step = 'awaiting_description_ge';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის აღწერა (ქართულად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_description_ge':
                    state.product.description.ge = msg.text;
                    state.step = 'awaiting_description_en';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის აღწერა (ინგლისურად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_description_en':
                    state.product.description.en = msg.text;
                    state.step = 'awaiting_category';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ კატეგორია (მაგ: dresses, shirts):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_category':
                    state.product.category = msg.text.toLowerCase();
                    state.step = 'awaiting_gender';
                    adminBot.sendMessage(msg.chat.id, 'მიუთითეთ სქესი (women ან men):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_gender':
                    state.product.gender = msg.text.toLowerCase();
                    state.step = 'awaiting_sizes';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ზომები მძიმით გამოყოფით (მაგ: S,M,L,XL):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_sizes':
                    state.product.sizes = msg.text.split(',').map(s => s.trim().toUpperCase());
                    state.step = 'awaiting_images';
                    adminBot.sendMessage(msg.chat.id, "ატვირთეთ ფოტო(ები) სათითაოდ. როდესაც დაასრულებთ, დაწერეთ 'done'.");
                    break;
                case 'awaiting_images':
                    if (msg.text.toLowerCase() === 'done') {
                        if (state.product.imageUrls.length === 0) return adminBot.sendMessage(msg.chat.id, "გთხოვთ, მინიმუმ ერთი ფოტო ატვირთოთ.");
                        const products = await readFileData(PRODUCTS_FILE_PATH, '[]');
                        const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
                        const newProduct = { id: newId, ...state.product };
                        products.push(newProduct);
                        await writeFileData(PRODUCTS_FILE_PATH, products);
                        adminBot.sendMessage(msg.chat.id, `პროდუქტი (ID: ${newId}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard });
                        resetState(msg.chat.id);
                    }
                    break;
                
                // --- ახალი ლოგიკა ხარისხის ფოტოებისთვის ---
                case 'awaiting_qc_images':
                    if (msg.text.toLowerCase() === 'done') {
                        if (state.qcImageUrls.length === 0) return adminBot.sendMessage(msg.chat.id, "გთხოვთ, მინიმუმ ერთი ფოტო ატვირთოთ.");
                        
                        const assets = { qualityCheckPhotos: state.qcImageUrls };
                        await writeFileData(SITE_ASSETS_FILE_PATH, assets);

                        adminBot.sendMessage(msg.chat.id, `ხარისხის შემოწმების ფოტოები წარმატებით განახლდა.`, { reply_markup: mainMenuKeyboard });
                        resetState(msg.chat.id);
                    }
                    break;

                // EDIT PRODUCT FLOW (იგივე რჩება)
                case 'awaiting_edit_images':
                     if (msg.text.toLowerCase() === 'done') {
                        if (state.newImageUrls.length === 0) return adminBot.sendMessage(msg.chat.id, "გთხოვთ, მინიმუმ ერთი ახალი ფოტო ატვირთოთ.");
                        const allProds = await readFileData(PRODUCTS_FILE_PATH, '[]');
                        const productIndex = allProds.findIndex(p => p.id === state.productId);
                        if (productIndex === -1) throw new Error('Product not found');
                        allProds[productIndex].imageUrls = state.newImageUrls;
                        await writeFileData(PRODUCTS_FILE_PATH, allProds);
                        adminBot.sendMessage(msg.chat.id, `პროდუქტის (ID: ${state.productId}) ფოტოები განახლდა.`);
                        resetState(msg.chat.id);
                     }
                     break;
                case 'awaiting_edit_value':
                    const allProds = await readFileData(PRODUCTS_FILE_PATH, '[]');
                    const productIndex = allProds.findIndex(p => p.id === state.productId);
                    if (productIndex === -1) throw new Error('Product not found');
                    
                    const productToEdit = allProds[productIndex];
                    let value = msg.text;

                    if (['price', 'oldPrice'].includes(state.field)) {
                        value = parseFloat(value).toFixed(2);
                        if (state.field === 'oldPrice' && parseFloat(value) === 0) value = null;
                    } else if (state.field === 'sizes') {
                        value = value.split(',').map(item => item.trim().toUpperCase());
                    }

                    if (state.subfield) {
                        productToEdit[state.field][state.subfield] = value;
                    } else {
                        productToEdit[state.field] = value;
                    }
                    
                    await writeFileData(PRODUCTS_FILE_PATH, allProds);
                    adminBot.sendMessage(msg.chat.id, `პროდუქტი (ID: ${state.productId}) განახლდა.`);
                    resetState(msg.chat.id);
                    break;
            }
        } catch (e) {
            adminBot.sendMessage(msg.chat.id, `დაფიქსირდა შეცდომა: ${e.message}\nსცადეთ თავიდან.`);
            resetState(msg.chat.id);
        }
    });
}

// =================================================================
// 2. ლაივ ჩატის ბოტის ლოგიკა
// =================================================================
let liveChatBot;
if (LIVE_CHAT_BOT_TOKEN) {
    liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });
    console.log('Live Chat Bot is running...');

    liveChatBot.onText(/\/chats/, async (msg) => {
        const chatId = msg.chat.id;
        const activeUserButtons = Object.values(activeChats).filter(chat => chat.status === 'active').map(chat => ([{ text: `${chat.name} (${chat.sessionId.slice(-5)})`, callback_data: `select_chat_${chat.sessionId}` }]));
        if (activeUserButtons.length === 0) return await liveChatBot.sendMessage(chatId, "ამჟამად აქტიური ჩატები არ არის.");
        await liveChatBot.sendMessage(chatId, "აირჩიეთ მომხმარებელი, ვისაც გსურთ რომ მისწეროთ:", { reply_markup: { inline_keyboard: activeUserButtons } });
    });

    liveChatBot.on('message', async (msg) => {
        if (msg.text && msg.text.startsWith('/')) return;
        const operatorId = msg.from.id;
        const selectedSessionId = operatorSelection[operatorId];
        if (selectedSessionId && activeChats[selectedSessionId]) {
            liveChatSessions[selectedSessionId] = { operatorMessage: msg.text };
            await liveChatBot.sendMessage(msg.chat.id, 'გაიგზავნა', { reply_to_message_id: msg.message_id });
        }
    });

    liveChatBot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const operator = callbackQuery.from;
        const data = callbackQuery.data;

        if (data.startsWith('accept_chat_')) {
            const sessionId = data.replace('accept_chat_', '');
            if (activeChats[sessionId]) {
                activeChats[sessionId].status = 'active';
                await liveChatBot.editMessageText(`${operator.first_name}-მა უპასუხა ჩატს:\n\nსახელი: ${activeChats[sessionId].name}`, { chat_id: msg.chat.id, message_id: msg.message_id });
                liveChatSessions[sessionId] = { operatorMessage: 'ოპერატორი შემოგიერთდათ. რით შემიძლია დაგეხმაროთ?' };
            }
        } else if (data.startsWith('decline_chat_')) {
            const sessionId = data.replace('decline_chat_', '');
            if (activeChats[sessionId]) {
                await liveChatBot.editMessageText(`ჩატის მოთხოვნა უარყოფილია (${operator.first_name}).`, { chat_id: msg.chat.id, message_id: msg.message_id });
                delete activeChats[sessionId];
                liveChatSessions[sessionId] = { operatorMessage: 'ბოდიშს გიხდით, ამჟამად ყველა ოპერატორი დაკავებულია.' };
            }
        } else if (data.startsWith('select_chat_')) {
            const sessionId = data.replace('select_chat_', '');
            if (activeChats[sessionId]) {
                operatorSelection[operator.id] = sessionId;
                await liveChatBot.sendMessage(operator.id, `თქვენ ახლა ესაუბრებით: ${activeChats[sessionId].name}. შეგიძლიათ პირდაპირ აქ დაწეროთ პასუხი.`);
                await liveChatBot.deleteMessage(msg.chat.id, msg.message_id);
            }
        }
        liveChatBot.answerCallbackQuery(callbackQuery.id);
    });
}

// =================================================================
// 3. API მარშრუტები (Endpoints)
// =================================================================
app.get('/api/products', async (req, res) => {
    try {
        const products = await readFileData(PRODUCTS_FILE_PATH, '[]');
        res.json(products);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

// --- ახალი API endpoint ხარისხის ფოტოებისთვის ---
app.get('/api/assets', async (req, res) => {
    try {
        const assets = await readFileData(SITE_ASSETS_FILE_PATH, '{}');
        res.json(assets);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch assets' });
    }
});


app.post('/api/submit-order', async (req, res) => {
    if (!adminBot || !TELEGRAM_CHANNEL_ID) return res.status(500).json({ success: false, message: 'Admin Bot not configured.' });
    
    const { customer, items, totalPrice } = req.body;
    const newOrderId = "LXRY" + Date.now().toString().slice(-6);

    const newOrder = {
        orderId: newOrderId,
        customer,
        items,
        totalPrice: parseFloat(totalPrice),
        date: new Date().toISOString()
    };
    
    try {
        const orders = await readFileData(ORDERS_FILE_PATH, '[]');
        orders.push(newOrder);
        await writeFileData(ORDERS_FILE_PATH, orders);
        
        const orderDetailsText = items.map(item => `- ${item.name.ge} (ზომა: ${item.size}) - ₾${item.price}`).join('\n');
        const customerInfoText = `\nსახელი: ${customer.firstName} ${customer.lastName}\nტელეფონი: ${customer.phone}\nმისამართი: ${customer.city}, ${customer.address}`;
        const notificationMessage = `**ახალი შეკვეთა!**\n\n**ID:** \`${newOrderId}\`\n\n**შეკვეთა:**\n${orderDetailsText}\n\n**სულ:** ₾${totalPrice}\n\n**მყიდველი:**${customerInfoText}`;
        
        adminBot.sendMessage(TELEGRAM_CHANNEL_ID, notificationMessage, { parse_mode: 'Markdown' });
        res.status(200).json({ success: true, orderId: newOrderId });
    } catch (error) {
        console.error("Order submission error:", error);
        res.status(500).json({ success: false, message: 'Failed to process order.' });
    }
});

app.get('/api/admin/sales-data', async (req, res) => {
    try {
        const { months } = req.query;
        const orders = await readFileData(ORDERS_FILE_PATH, '[]');

        let filteredOrders = orders;
        if (months) {
            const dateLimit = new Date();
            dateLimit.setMonth(dateLimit.getMonth() - parseInt(months));
            filteredOrders = orders.filter(order => new Date(order.date) >= dateLimit);
        }

        const totalRevenue = filteredOrders.reduce((sum, order) => sum + order.totalPrice, 0);
        const totalSales = filteredOrders.length;
        
        const recentSales = [...filteredOrders].reverse().slice(0, 50);

        res.json({
            totalRevenue: totalRevenue.toFixed(2),
            totalSales,
            recentSales
        });
    } catch (err) {
        console.error("API Error fetching sales data:", err);
        res.status(500).json({ success: false, message: 'Could not fetch sales data' });
    }
});

app.post('/api/live-chat', async (req, res) => {
    if (!liveChatBot || !TELEGRAM_CHANNEL_ID) return res.status(500).json({ success: false, message: 'Live Chat Bot not configured.' });
    
    const { message, sessionId, isNewChat, userData } = req.body;
    
    if (isNewChat && userData) {
        activeChats[sessionId] = { sessionId, name: userData.name, email: userData.email, orderId: userData.orderId, status: 'pending' };
        const initialMessage = `**ახალი ჩატის მოთხოვნა**\n\n**სახელი:** ${userData.name}\n**მეილი:** ${userData.email}\n**შეკვეთა:** ${userData.orderId || 'არ არის'}\n\n**შეტყობინება:**\n_"${message}"_`;
        try {
            await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, initialMessage, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "პასუხის გაცემა", callback_data: `accept_chat_${sessionId}` }, { text: "უარყოფა", callback_data: `decline_chat_${sessionId}` }]] } });
            res.status(200).json({ success: true });
        } catch (error) { res.status(500).json({ success: false, message: 'Failed to notify operator.' }); }
    } else if (activeChats[sessionId] && activeChats[sessionId].status === 'active') {
        const ongoingMessage = `**${activeChats[sessionId].name}:** ${message}`;
        try {
            await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, ongoingMessage, { parse_mode: 'Markdown' });
            res.status(200).json({ success: true });
        } catch (error) { res.status(500).json({ success: false, message: 'Failed to send message.' }); }
    } else {
        res.status(400).json({ success: false, message: 'Chat session not active or invalid.' });
    }
});

app.get('/api/chat-response/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (liveChatSessions[sessionId]) {
        res.json({ success: true, message: liveChatSessions[sessionId].operatorMessage });
        delete liveChatSessions[sessionId];
    } else {
        res.json({ success: true, message: null });
    }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
