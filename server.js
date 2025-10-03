const express = require('express');
const path = require('path');
const fs = require('fs');
const { Telegraf } = require('telegraf');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot Tokens (შეცვალე შენი ბოტების ტოკენებით)
const PRODUCT_BOT_TOKEN = process.env.PRODUCT_BOT_TOKEN || 'your_product_bot_token_here';
const CHAT_BOT_TOKEN = process.env.CHAT_BOT_TOKEN || 'your_chat_bot_token_here';

// Initialize Telegram Bots
const productBot = new Telegraf(PRODUCT_BOT_TOKEN);
const chatBot = new Telegraf(CHAT_BOT_TOKEN);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('.'));

// Store active chat sessions
const chatSessions = new Map();
const operatorResponses = new Map();

// Products data file
const PRODUCTS_FILE = 'products.json';
const ORDERS_FILE = 'orders.json';
const CHAT_SESSIONS_FILE = 'chat_sessions.json';

// Helper functions for file operations
const readProducts = () => {
    try {
        if (fs.existsSync(PRODUCTS_FILE)) {
            return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading products:', error);
    }
    return [];
};

const saveProducts = (products) => {
    try {
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving products:', error);
        return false;
    }
};

const readOrders = () => {
    try {
        if (fs.existsSync(ORDERS_FILE)) {
            return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading orders:', error);
    }
    return {};
};

const saveChatSessions = () => {
    try {
        const sessions = Array.from(chatSessions.entries()).reduce((acc, [key, value]) => {
            acc[key] = value;
            return acc;
        }, {});
        fs.writeFileSync(CHAT_SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    } catch (error) {
        console.error('Error saving chat sessions:', error);
    }
};

const loadChatSessions = () => {
    try {
        if (fs.existsSync(CHAT_SESSIONS_FILE)) {
            const sessions = JSON.parse(fs.readFileSync(CHAT_SESSIONS_FILE, 'utf8'));
            Object.entries(sessions).forEach(([key, value]) => {
                chatSessions.set(key, value);
            });
        }
    } catch (error) {
        console.error('Error loading chat sessions:', error);
    }
};

// Initialize products file with sample data if empty
const initializeProducts = () => {
    const products = readProducts();
    if (products.length === 0) {
        const sampleProducts = [
            {
                "id": 1,
                "name": {"ge": "საზაფხულო კაბა", "en": "Summer Dress"},
                "price": "129.99",
                "oldPrice": "159.99",
                "category": "dresses",
                "gender": "women",
                "imageUrls": [
                    'https://i.ibb.co/6y18B9M/image-1.png',
                    'https://i.ibb.co/hZ2vWJm/image-2.png',
                    'https://i.ibb.co/C0bN0Gk/image-3.png'
                ],
                "qcImages": [
                    'https://i.ibb.co/6y18B9M/image-1.png',
                    'https://i.ibb.co/hZ2vWJm/image-2.png'
                ],
                "sizes": ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
                "description": {
                    "ge": "მსუბუქი და ჰაეროვანი საზაფხულო კაბა, იდეალური ცხელი დღეებისთვის.",
                    "en": "A light and airy summer dress, perfect for hot days."
                }
            },
            {
                "id": 6,
                "name": {"ge": "კლასიკური პერანგი", "en": "Classic Shirt"},
                "price": "110.00",
                "oldPrice": "140.00",
                "category": "shirts",
                "gender": "men",
                "imageUrls": [
                    'https://i.ibb.co/Q8Qf1dY/pexels-dmitry-zvolskiy-2064505.jpg',
                    'https://i.ibb.co/yWz33J3/pexels-justin-shaifer-1222271.jpg'
                ],
                "qcImages": [
                    'https://i.ibb.co/Q8Qf1dY/pexels-dmitry-zvolskiy-2064505.jpg'
                ],
                "sizes": ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
                "description": {
                    "ge": "დახვეწილი და კლასიკური პერანგი თანამედროვე მამაკაცისთვის.",
                    "en": "A sophisticated and classic shirt for the modern man."
                }
            }
        ];
        saveProducts(sampleProducts);
    }
};

// Telegram Bot Commands for Product Management
productBot.command('start', (ctx) => {
    ctx.reply(
        '🛍️ პროდუქტების მართვის ბოტი\n\n' +
        'ბრძანებები:\n' +
        '/products - ყველა პროდუქტის ნახვა\n' +
        '/addproduct - ახალი პროდუქტის დამატება\n' +
        '/editproduct - პროდუქტის რედაქტირება\n' +
        '/deleteproduct - პროდუქტის წაშლა\n' +
        '/help - დახმარება'
    );
});

productBot.command('products', (ctx) => {
    const products = readProducts();
    if (products.length === 0) {
        return ctx.reply('📦 პროდუქტები ვერ მოიძებნა.');
    }

    products.forEach((product, index) => {
        const message = `
🆔 ID: ${product.id}
🏷️ სახელი: ${product.name.ge} / ${product.name.en}
💰 ფასი: ₾${product.price}${product.oldPrice ? ` (ძველი: ₾${product.oldPrice})` : ''}
📂 კატეგორია: ${product.category}
👥 გენდერი: ${product.gender}
📏 ზომები: ${product.sizes.join(', ')}
📝 აღწერა: ${product.description.ge}

🖼️ სურათები: ${product.imageUrls.length}
✅ QC სურათები: ${product.qcImages ? product.qcImages.length : 0}
        `.trim();

        // Send first image if available
        if (product.imageUrls.length > 0) {
            ctx.replyWithPhoto(product.imageUrls[0], { caption: message });
        } else {
            ctx.reply(message);
        }
    });
});

// Add product conversation
productBot.command('addproduct', (ctx) => {
    ctx.reply('📝 ახალი პროდუქტის დამატება\n\nშეიყვანეთ პროდუქტის სახელი ქართულად:');
    ctx.session = { addingProduct: true, step: 'name_ge' };
});

productBot.on('text', (ctx) => {
    if (ctx.session && ctx.session.addingProduct) {
        handleAddProductFlow(ctx);
    } else if (ctx.session && ctx.session.editingProduct) {
        handleEditProductFlow(ctx);
    }
});

productBot.on('photo', (ctx) => {
    if (ctx.session && (ctx.session.addingProduct || ctx.session.editingProduct)) {
        handleProductPhotos(ctx);
    }
});

const handleAddProductFlow = (ctx) => {
    const session = ctx.session;
    const text = ctx.message.text;

    switch (session.step) {
        case 'name_ge':
            session.productData = { name: { ge: text } };
            ctx.reply('შეიყვანეთ პროდუქტის სახელი ინგლისურად:');
            session.step = 'name_en';
            break;

        case 'name_en':
            session.productData.name.en = text;
            ctx.reply('შეიყვანეთ ფასი (მაგ: 129.99):');
            session.step = 'price';
            break;

        case 'price':
            session.productData.price = text;
            ctx.reply('შეიყვანეთ ძველი ფასი (თუ არ არის, დაწერეთ "0"):');
            session.step = 'oldPrice';
            break;

        case 'oldPrice':
            session.productData.oldPrice = text === '0' ? '' : text;
            ctx.reply('შეიყვანეთ კატეგორია (dresses, shirts, coats, etc.):');
            session.step = 'category';
            break;

        case 'category':
            session.productData.category = text;
            ctx.reply('შეიყვანეთ გენდერი (men/women):');
            session.step = 'gender';
            break;

        case 'gender':
            session.productData.gender = text;
            ctx.reply('შეიყვანეთ ზომები, გამოყავით მძიმით (მაგ: XS,S,M,L,XL):');
            session.step = 'sizes';
            break;

        case 'sizes':
            session.productData.sizes = text.split(',').map(s => s.trim());
            ctx.reply('შეიყვანეთ აღწერა ქართულად:');
            session.step = 'description_ge';
            break;

        case 'description_ge':
            session.productData.description = { ge: text };
            ctx.reply('შეიყვანეთ აღწერა ინგლისურად:');
            session.step = 'description_en';
            break;

        case 'description_en':
            session.productData.description.en = text;
            ctx.reply('📸 გამოაგზავნეთ პროდუქტის სურათები (ერთი ან მეტი):');
            session.step = 'images';
            session.productData.imageUrls = [];
            break;

        case 'images':
            if (session.productData.imageUrls.length > 0) {
                // Already collecting images via photo handler
                break;
            }
            // Fall through to ask for QC images

        case 'qc_images':
            if (session.step === 'images' && session.productData.imageUrls.length === 0) {
                ctx.reply('გთხოვთ გამოაგზავნოთ მინიმუმ ერთი სურათი პროდუქტისთვის.');
                return;
            }
            ctx.reply('📸 გამოაგზავნეთ QC სურათები (ხარისხის კონტროლი):');
            session.step = 'qc_images';
            session.productData.qcImages = [];
            break;

        case 'save_product':
            // This step is triggered after QC images are received
            saveNewProduct(ctx, session.productData);
            delete ctx.session;
            break;
    }
};

const handleProductPhotos = async (ctx) => {
    const session = ctx.session;
    if (!session || (!session.addingProduct && !session.editingProduct)) return;

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const imageUrl = fileLink.href;

    if (session.step === 'images') {
        session.productData.imageUrls.push(imageUrl);
        ctx.reply(`✅ სურათი დამატებული! სულ: ${session.productData.imageUrls.length}\nგამოაგზავნეთ მეტი სურათი ან დაწერეთ "გაგრძელება" QC სურათებისთვის.`);
    } else if (session.step === 'qc_images') {
        session.productData.qcImages.push(imageUrl);
        ctx.reply(`✅ QC სურათი დამატებული! სულ: ${session.productData.qcImages.length}\nგამოაგზავნეთ მეტი სურათი ან დაწერეთ "დასრულება" პროდუქტის შესანახად.`);
    }
};

const saveNewProduct = (ctx, productData) => {
    const products = readProducts();
    const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
    
    const newProduct = {
        id: newId,
        ...productData
    };

    products.push(newProduct);
    
    if (saveProducts(products)) {
        ctx.reply(`✅ პროდუქტი წარმატებით დაემატა!\nID: ${newId}\nსახელი: ${newProduct.name.ge}`);
    } else {
        ctx.reply('❌ შეცდომა პროდუქტის დამატებისას.');
    }
};

// Edit product command
productBot.command('editproduct', (ctx) => {
    const products = readProducts();
    if (products.length === 0) {
        return ctx.reply('📦 პროდუქტები ვერ მოიძებნა.');
    }

    let message = '📝 აირჩიეთ პროდუქტი რედაქტირებისთვის:\n\n';
    products.forEach(product => {
        message += `${product.id}. ${product.name.ge}\n`;
    });
    message += '\nშეიყვანეთ პროდუქტის ID:';

    ctx.reply(message);
    ctx.session = { editingProduct: true, step: 'select_product' };
});

const handleEditProductFlow = (ctx) => {
    const session = ctx.session;
    const text = ctx.message.text;
    const products = readProducts();

    switch (session.step) {
        case 'select_product':
            const productId = parseInt(text);
            const product = products.find(p => p.id === productId);
            
            if (!product) {
                ctx.reply('❌ პროდუქტი ვერ მოიძებნა. სცადეთ ხელახლა:');
                return;
            }

            session.editingProductId = productId;
            session.productData = JSON.parse(JSON.stringify(product)); // Deep copy
            
            ctx.reply(
                `✏️ რედაქტირება: ${product.name.ge}\n\n` +
                'რა გსურთ შეცვალოთ?\n' +
                '1. სახელი\n' +
                '2. ფასი\n' +
                '3. კატეგორია\n' +
                '4. აღწერა\n' +
                '5. სურათები\n' +
                '6. QC სურათები\n' +
                '7. ზომები\n\n' +
                'შეიყვანეთ ნომერი:'
            );
            session.step = 'select_field';
            break;

        case 'select_field':
            const choice = parseInt(text);
            const fieldMap = {
                1: 'name',
                2: 'price',
                3: 'category',
                4: 'description',
                5: 'images',
                6: 'qc_images',
                7: 'sizes'
            };

            if (!fieldMap[choice]) {
                ctx.reply('❌ არასწორი არჩევანი. სცადეთ ხელახლა:');
                return;
            }

            session.editingField = fieldMap[choice];
            
            switch (fieldMap[choice]) {
                case 'name':
                    ctx.reply('შეიყვანეთ ახალი სახელი ქართულად:');
                    session.step = 'edit_name_ge';
                    break;
                case 'price':
                    ctx.reply('შეიყვანეთ ახალი ფასი:');
                    session.step = 'edit_price';
                    break;
                case 'category':
                    ctx.reply('შეიყვანეთ ახალი კატეგორია:');
                    session.step = 'edit_category';
                    break;
                case 'description':
                    ctx.reply('შეიყვანეთ ახალი აღწერა ქართულად:');
                    session.step = 'edit_description_ge';
                    break;
                case 'images':
                    ctx.reply('📸 გამოაგზავნეთ ახალი სურათები:');
                    session.step = 'edit_images';
                    session.productData.imageUrls = [];
                    break;
                case 'qc_images':
                    ctx.reply('📸 გამოაგზავნეთ ახალი QC სურათები:');
                    session.step = 'edit_qc_images';
                    session.productData.qcImages = [];
                    break;
                case 'sizes':
                    ctx.reply('შეიყვანეთ ახალი ზომები, გამოყავით მძიმით:');
                    session.step = 'edit_sizes';
                    break;
            }
            break;

        case 'edit_name_ge':
            session.productData.name.ge = text;
            ctx.reply('შეიყვანეთ ახალი სახელი ინგლისურად:');
            session.step = 'edit_name_en';
            break;

        case 'edit_name_en':
            session.productData.name.en = text;
            saveEditedProduct(ctx, session);
            break;

        case 'edit_price':
            session.productData.price = text;
            saveEditedProduct(ctx, session);
            break;

        case 'edit_category':
            session.productData.category = text;
            saveEditedProduct(ctx, session);
            break;

        case 'edit_description_ge':
            session.productData.description.ge = text;
            ctx.reply('შეიყვანეთ ახალი აღწერა ინგლისურად:');
            session.step = 'edit_description_en';
            break;

        case 'edit_description_en':
            session.productData.description.en = text;
            saveEditedProduct(ctx, session);
            break;

        case 'edit_sizes':
            session.productData.sizes = text.split(',').map(s => s.trim());
            saveEditedProduct(ctx, session);
            break;

        case 'edit_images':
        case 'edit_qc_images':
            // Handled by photo handler
            if (text && text.toLowerCase() === 'დასრულება') {
                saveEditedProduct(ctx, session);
            }
            break;
    }
};

const saveEditedProduct = (ctx, session) => {
    const products = readProducts();
    const productIndex = products.findIndex(p => p.id === session.editingProductId);
    
    if (productIndex === -1) {
        ctx.reply('❌ პროდუქტი ვერ მოიძებნა.');
        delete ctx.session;
        return;
    }

    products[productIndex] = session.productData;
    
    if (saveProducts(products)) {
        ctx.reply(`✅ პროდუქტი წარმატებით განახლდა!\nID: ${session.editingProductId}`);
    } else {
        ctx.reply('❌ შეცდომა პროდუქტის განახლებისას.');
    }
    
    delete ctx.session;
};

// Delete product command
productBot.command('deleteproduct', (ctx) => {
    const products = readProducts();
    if (products.length === 0) {
        return ctx.reply('📦 პროდუქტები ვერ მოიძებნა.');
    }

    let message = '🗑️ აირჩიეთ პროდუქტი წასაშლელად:\n\n';
    products.forEach(product => {
        message += `${product.id}. ${product.name.ge}\n`;
    });
    message += '\nშეიყვანეთ პროდუქტის ID:';

    ctx.reply(message);
    ctx.session = { deletingProduct: true };
});

productBot.on('text', (ctx) => {
    if (ctx.session && ctx.session.deletingProduct) {
        handleDeleteProduct(ctx);
    }
});

const handleDeleteProduct = (ctx) => {
    const productId = parseInt(ctx.message.text);
    const products = readProducts();
    const productIndex = products.findIndex(p => p.id === productId);
    
    if (productIndex === -1) {
        ctx.reply('❌ პროდუქტი ვერ მოიძებნა.');
        delete ctx.session;
        return;
    }

    const productName = products[productIndex].name.ge;
    products.splice(productIndex, 1);
    
    if (saveProducts(products)) {
        ctx.reply(`✅ პროდუქტი წარმატებით წაიშალა!\nსახელი: ${productName}`);
    } else {
        ctx.reply('❌ შეცდომა პროდუქტის წაშლისას.');
    }
    
    delete ctx.session;
};

// Live Chat Bot for Customer Support
chatBot.command('start', (ctx) => {
    ctx.reply(
        '💬 ლაივ ჩატის ოპერატორის ბოტი\n\n' +
        'ეს ბოტი გამოიყენება მომხმარებლებისთვის პასუხების გასაცემად.'
    );
});

// Webhook endpoint for live chat from website
app.post('/api/live-chat', async (req, res) => {
    try {
        const { message, sessionId, customerInfo } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Session ID required' });
        }

        // Store chat session
        const sessionData = {
            sessionId,
            customerInfo: customerInfo || {},
            messages: [...(chatSessions.get(sessionId)?.messages || []), {
                type: 'user',
                text: message,
                timestamp: new Date().toISOString()
            }]
        };

        chatSessions.set(sessionId, sessionData);
        saveChatSessions();

        // Notify operators about new message
        const operatorMessage = `
💬 ახალი მესიჯი ლაივ ჩატიდან:

👤 მომხმარებელი: ${customerInfo?.firstName || 'არაა მითითებული'} ${customerInfo?.lastName || ''}
📞 ტელეფონი: ${customerInfo?.phone || 'არაა მითითებული'}
📧 Email: ${customerInfo?.email || 'არაა მითითებული'}
📦 შეკვეთის ნომერი: ${customerInfo?.orderId || 'არაა მითითებული'}

💭 მესიჯი: ${message}

Session ID: ${sessionId}

პასუხის გასაცემად გამოიყენეთ ბრძანება:
/reply_${sessionId} [თქვენი პასუხი]
        `.trim();

        // Send to all operators (in real implementation, you'd have a list of operator chat IDs)
        // For now, we'll store the session and operators can use /sessions command
        res.json({ success: true });
    } catch (error) {
        console.error('Live chat error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Command to see active chat sessions
chatBot.command('sessions', (ctx) => {
    if (chatSessions.size === 0) {
        return ctx.reply('📭 აქტიური ჩატ სესიები არ არის.');
    }

    let message = '💬 აქტიური ჩატ სესიები:\n\n';
    
    chatSessions.forEach((session, sessionId) => {
        const customer = session.customerInfo;
        message += `Session: ${sessionId}\n`;
        message += `მომხმარებელი: ${customer.firstName || 'არაა'} ${customer.lastName || ''}\n`;
        message += `ტელეფონი: ${customer.phone || 'არაა'}\n`;
        message += `ბოლო მესიჯი: ${session.messages[session.messages.length - 1]?.text?.substring(0, 50)}...\n`;
        message += `პასუხისთვის: /reply_${sessionId}\n\n`;
    });

    ctx.reply(message);
});

// Handle operator replies
chatBot.hears(/^\/reply_([a-zA-Z0-9-]+)$/, (ctx) => {
    const sessionId = ctx.match[1];
    const session = chatSessions.get(sessionId);
    
    if (!session) {
        return ctx.reply('❌ ჩატ სესია ვერ მოიძებნა.');
    }

    ctx.reply(
        `💬 პასუხის გაცემა Session: ${sessionId}\n\n` +
        `მომხმარებელი: ${session.customerInfo.firstName || 'არაა'} ${session.customerInfo.lastName || ''}\n` +
        `ტელეფონი: ${session.customerInfo.phone || 'არაა'}\n\n` +
        'დაწერეთ თქვენი პასუხი:'
    );

    ctx.session = { replyingTo: sessionId };
});

chatBot.on('text', (ctx) => {
    if (ctx.session && ctx.session.replyingTo) {
        handleOperatorReply(ctx);
    }
});

const handleOperatorReply = async (ctx) => {
    const sessionId = ctx.session.replyingTo;
    const operatorMessage = ctx.message.text;
    const session = chatSessions.get(sessionId);
    
    if (!session) {
        ctx.reply('❌ ჩატ სესია ვერ მოიძებნა.');
        delete ctx.session;
        return;
    }

    // Store operator response to send to website
    operatorResponses.set(sessionId, {
        message: operatorMessage,
        timestamp: new Date().toISOString()
    });

    // Add to session messages
    session.messages.push({
        type: 'operator',
        text: operatorMessage,
        timestamp: new Date().toISOString()
    });

    chatSessions.set(sessionId, session);
    saveChatSessions();

    ctx.reply(`✅ პასუხი გაიგზავნა მომხმარებელთან!\nSession: ${sessionId}`);
    delete ctx.session;
};

// Endpoint to get operator responses for website
app.get('/api/chat-response/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const response = operatorResponses.get(sessionId);
    
    if (response) {
        operatorResponses.delete(sessionId); // Remove after sending
        res.json({ success: true, message: response.message });
    } else {
        res.json({ success: false, message: null });
    }
});

// Get chat history
app.get('/api/chat-history/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = chatSessions.get(sessionId);
    
    if (session) {
        res.json({ success: true, messages: session.messages });
    } else {
        res.json({ success: true, messages: [] });
    }
});

// Products API Endpoint
app.get('/api/products', (req, res) => {
    const products = readProducts();
    res.json(products);
});

// Order Submission API Endpoint
app.post('/api/submit-order', (req, res) => {
    const orderData = req.body;
    const orderId = "LXRY" + Date.now();
    orderData.orderId = orderId;

    const orders = readOrders();
    orders[orderId] = {
        "data": orderData,
        "status": "შეკვეთა მიღებულია. დაგიკავშირდებით დეტალების დასაზუსტებლად."
    };
    
    try {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
        res.json({success: true, orderId: orderId});
    } catch (error) {
        console.error('Error saving order:', error);
        res.json({success: false, error: error.message});
    }
});

// Sales Data API Endpoint for Admin Panel
app.get('/api/sales-data', (req, res) => {
    const orders = readOrders();
    const sales_data = [];

    Object.entries(orders).forEach(([orderId, order]) => {
        const timestamp = parseInt(orderId.substring(4));
        let product_name_ge = "შეკვეთა";
        
        if (order.data && order.data.items && order.data.items.length > 0) {
            const first_item = order.data.items[0];
            product_name_ge = first_item.name?.ge || "პროდუქტი";
            if (order.data.items.length > 1) {
                product_name_ge += " + " + (order.data.items.length - 1) + " სხვა";
            }
        }
        
        sales_data.push({
            "orderId": orderId,
            "name": product_name_ge,
            "price": parseFloat(order.data.totalPrice),
            "date": new Date(timestamp).toISOString().split('T')[0],
            "customer": order.data.customer
        });
    });

    sales_data.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(sales_data);
});

// Order Status API Endpoint
app.get('/api/order-status/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    const orders = readOrders();
    
    if (orders[orderId]) {
        res.json({status: orders[orderId].status});
    } else {
        res.status(404).json({status: 'შეკვეთის ID ვერ მოიძებნა.'});
    }
});

// Serve index.php as the main file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.php'));
});

// Initialize data and start bots
const startServer = async () => {
    try {
        // Initialize data
        initializeProducts();
        loadChatSessions();

        // Start Telegram bots
        await productBot.launch();
        await chatBot.launch();
        
        console.log('🤖 Telegram bots started successfully');
        console.log('🛍️ Product Bot: Ready for product management');
        console.log('💬 Chat Bot: Ready for live chat support');

        // Start Express server
        app.listen(PORT, () => {
            console.log(`🚀 Server is running on port ${PORT}`);
            console.log(`📱 Website: http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Error starting server:', error);
    }
};

// Graceful shutdown
process.once('SIGINT', () => {
    productBot.stop('SIGINT');
    chatBot.stop('SIGINT');
});

process.once('SIGTERM', () => {
    productBot.stop('SIGTERM');
    chatBot.stop('SIGTERM');
});

startServer();