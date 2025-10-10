app.post('/api/submit-order', async (req, res) => {
    try {
        const orderData = req.body;
        console.log('Received order data:', orderData);
        
        // First save order to database with pending status
        const orderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
        
        await pool.query(
            'INSERT INTO orders (order_id, customer_data, items, total_price, status) VALUES ($1, $2, $3, $4, $5)',
            [orderId, orderData.customer, orderData.items, orderData.totalPrice, 'payment_pending']
        );

        console.log('Order saved to database:', orderId);

        // Initiate BOG payment
        const paymentResponse = await axios.post(`https://${req.get('host')}/api/process-payment`, {
            amount: orderData.totalPrice,
            name: `Order ${orderId}`,
            orderData: orderData
        });

        console.log('Payment response:', paymentResponse.data);

        if (paymentResponse.data.success) {
            res.json({
                success: true,
                orderId: orderId,
                redirect_url: paymentResponse.data.redirect_url,
                message: 'Order submitted successfully. Redirecting to payment...'
            });
        } else {
            throw new Error('Payment initiation failed: ' + JSON.stringify(paymentResponse.data));
        }

    } catch (error) {
        console.error('Order submission failed:', error);
        res.status(500).json({
            success: false,
            error: 'Order submission failed. Please try again later.',
            details: error.message
        });
    }
});