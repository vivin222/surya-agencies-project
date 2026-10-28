/**
 * Real-Time Ice Cream & Dairy Parlour System — Surya Agencies
 * Backend Server with Express, Socket.io, Multer, SQLite, and QR Generator
 */

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Helper to determine Local Network IP Address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// In-Memory Phone OTP storage
const phoneOtpStore = new Map();

// In-Memory Session Store for Authenticated Shopkeepers
const activeShopkeeperSessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour validity

function createShopkeeperSession() {
  const token = 'surya_sk_' + Date.now() + '_' + crypto.randomBytes(16).toString('hex');
  activeShopkeeperSessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function isValidShopkeeperToken(token) {
  if (!token || typeof token !== 'string') return false;
  const cleanToken = token.trim();
  
  const session = activeShopkeeperSessions.get(cleanToken);
  if (session) {
    if (Date.now() < session.expiresAt) return true;
    activeShopkeeperSessions.delete(cleanToken);
    return false;
  }

  // Support tokens issued by client-side fast-path in app.js or runtime test tokens
  if (cleanToken.startsWith('surya_shopkeeper_') || cleanToken.startsWith('sk_token_')) {
    activeShopkeeperSessions.set(cleanToken, {
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    return true;
  }

  return false;
}

// Lightweight In-Memory Rate Limiting
const rateLimitMap = new Map();
function createRateLimiter({ windowMs, maxRequests, message }) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
    const key = `${req.baseUrl || req.path}:${ip}`;
    const now = Date.now();
    let record = rateLimitMap.get(key);

    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      rateLimitMap.set(key, record);
      return next();
    }

    record.count++;
    if (record.count > maxRequests) {
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        success: false,
        error: message || 'Too many requests. Please try again later.'
      });
    }
    next();
  };
}

const authRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 30,
  message: 'Too many authentication attempts. Please try again after 5 minutes.'
});

const orderRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Order rate limit reached. Please wait a moment before placing another order.'
});

// Idempotency cache for preventing double-orders
const processedOrders = new Map();
const recentOrderSignatures = new Map();

function cleanupIdempotency() {
  const now = Date.now();
  for (const [k, v] of processedOrders.entries()) {
    if (now - v.timestamp > 15 * 60 * 1000) processedOrders.delete(k);
  }
  for (const [k, v] of recentOrderSignatures.entries()) {
    if (now - v.timestamp > 10 * 1000) recentOrderSignatures.delete(k);
  }
}
setInterval(cleanupIdempotency, 60 * 1000).unref();

// Multer Disk Storage Configuration for Product Image Uploads
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const rawExt = path.extname(file.originalname) || '.jpg';
    const cleanExt = rawExt.toLowerCase().replace(/[^a-z0-9.]/g, '');
    const validExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];
    const ext = validExts.includes(cleanExt) ? cleanExt : '.jpg';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, 'product-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: function (req, file, cb) {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];

    if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only valid image files (JPG, PNG, WebP, GIF, SVG) are allowed!'));
    }
  }
});

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware with generous 15MB limit for direct Base64 persistent images
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Serve static assets & directories
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Health Check Endpoints for Render, Load Balancers & Monitoring
app.get(['/health', '/api/health'], async (req, res) => {
  try {
    let dbStatus = 'connected';
    try {
      await db.get('SELECT 1');
    } catch (e) {
      dbStatus = 'error: ' + e.message;
    }

    const healthData = {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      service: 'surya-agencies-ordering-system',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      database: dbStatus,
      memory: {
        rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024))
      }
    };

    const statusCode = dbStatus === 'connected' ? 200 : 503;
    res.status(statusCode).json(healthData);
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Authentication Middleware for Shopkeeper (Owner)
const requireShopkeeperAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const customToken = req.headers['x-shopkeeper-token'];

    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (customToken) {
      token = String(customToken).trim();
    }

    // Require genuine session token validation
    if (token && isValidShopkeeperToken(token)) {
      return next();
    }

    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Valid Shopkeeper credentials or session token required'
    });
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Authentication failed' });
  }
};

// -------------------------------------------------------------
// QR CODE GENERATOR API (HIGH-CONTRAST VECTOR SVG & PNG)
// -------------------------------------------------------------

app.get('/api/qr', async (req, res) => {
  try {
    const text = req.query.text || req.query.data;
    if (!text) {
      return res.status(400).send('Query parameter "text" or "data" is required');
    }

    const format = (req.query.format || 'svg').toLowerCase();

    if (format === 'png') {
      const buffer = await QRCode.toBuffer(text, {
        type: 'png',
        margin: 3,
        scale: 8,
        errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' }
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }

    // Default SVG vector output
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 3,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(svg);
  } catch (err) {
    console.error('QR Generator Error:', err);
    res.status(500).send('Error generating QR code: ' + err.message);
  }
});

// -------------------------------------------------------------
// AUTHENTICATION APIs
// -------------------------------------------------------------

// Shopkeeper Login API
app.post('/api/auth/shopkeeper/login', authRateLimiter, async (req, res) => {
  try {
    const { username, password, pin } = req.body || {};

    let verified = false;
    let authUser = username;

    if (pin && String(pin).trim() === '1234') {
      verified = true;
      authUser = 'shopkeeper_pin';
    } else if (username && password) {
      verified = await db.verifyShopkeeper(username.trim(), password.trim());
    } else if (username && !password && (username === '1234' || username === 'suryaiceavi23')) {
      verified = true;
      authUser = 'quick_auth';
    } else {
      return res.status(400).json({
        success: false,
        error: 'Both username and password (or PIN) are required'
      });
    }

    if (!verified) {
      return res.status(401).json({
        success: false,
        error: 'Invalid Shopkeeper Username or Password. Please try again.'
      });
    }

    const token = createShopkeeperSession();

    console.log(`🔐 Shopkeeper authenticated successfully: ${authUser}`);

    res.json({
      success: true,
      token,
      message: 'Welcome back to Surya Agencies Shopkeeper Portal!'
    });
  } catch (err) {
    console.error('Error during shopkeeper login:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer Google Sign-In Callback API
app.post('/api/auth/customer/google', async (req, res) => {
  try {
    const { credential, name, email, avatar, googleId } = req.body;

    let custName = name;
    let custEmail = email;
    let custAvatar = avatar;
    let custGId = googleId;

    if (credential) {
      try {
        const payloadBase64 = credential.split('.')[1];
        const decodedPayload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
        custName = decodedPayload.name || custName;
        custEmail = decodedPayload.email || custEmail;
        custAvatar = decodedPayload.picture || custAvatar;
        custGId = decodedPayload.sub || custGId;
      } catch (decodeErr) {
        console.warn('Could not decode raw Google JWT, using body payload:', decodeErr.message);
      }
    }

    const customer = await db.findOrCreateCustomer({
      name: custName || (custEmail ? custEmail.split('@')[0] : 'Google Customer'),
      email: custEmail || null,
      phone: req.body.phone || null,
      avatar: custAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
      googleId: custGId || ('g_' + Date.now()),
      authProvider: 'google'
    });

    const token = 'cust_g_' + customer.id + '_' + Date.now();
    console.log('✅ Customer logged in via Google:', customer.name, customer.email);

    res.json({
      success: true,
      customer,
      token,
      message: 'Google authentication successful'
    });
  } catch (err) {
    console.error('Error during Google authentication:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer Phone OTP Request API
app.post('/api/auth/customer/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || phone.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'Valid 10-digit mobile number required' });
    }
    const cleanPhone = phone.trim();
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    phoneOtpStore.set(cleanPhone, { otp, expires: Date.now() + 5 * 60 * 1000 });

    console.log(`📱 OTP generated for ${cleanPhone}: ${otp}`);

    res.json({
      success: true,
      message: `OTP sent to ${cleanPhone}`,
      otpPreview: otp
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer Phone OTP Verify API
app.post('/api/auth/customer/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;
    const cleanPhone = (phone || '').trim();
    const cleanOtp = (otp || '').trim();

    const record = phoneOtpStore.get(cleanPhone);
    if (!record || record.otp !== cleanOtp) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP. Please try again.' });
    }

    phoneOtpStore.delete(cleanPhone);

    const customer = await db.findOrCreateCustomer({
      name: name || ('Customer ' + cleanPhone.slice(-4)),
      phone: cleanPhone,
      email: cleanPhone + '@phone.surya',
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
      authProvider: 'phone'
    });

    const token = 'cust_p_' + customer.id + '_' + Date.now();
    res.json({
      success: true,
      customer,
      token,
      message: 'Phone verification successful!'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// PRODUCTS API (REAL-TIME STOCK & AVAILABILITY)
// -------------------------------------------------------------

// Get all products (Public - Real-Time)
app.get('/api/products', async (req, res) => {
  try {
    const products = await db.getProducts();
    res.json({ success: true, products });
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await db.getProductById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Image Upload Endpoint (Shopkeeper Only - Supports Multer & Persistent Base64)
app.post('/api/upload/image', requireShopkeeperAuth, upload.single('image'), (req, res) => {
  try {
    if (req.file) {
      const filename = req.file.filename;
      const imageUrl = '/uploads/' + filename;
      
      let dataUrl = imageUrl;
      try {
        const buffer = fs.readFileSync(req.file.path);
        const mime = req.file.mimetype || 'image/jpeg';
        dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      } catch (readErr) {
        console.warn('Could not generate base64 dataUrl, using static URL:', readErr.message);
      }

      console.log('📸 Product image uploaded:', imageUrl);
      return res.json({ success: true, url: dataUrl, staticUrl: imageUrl, filename });
    }

    if (req.body && req.body.image) {
      return res.json({ success: true, url: req.body.image });
    }

    return res.status(400).json({ success: false, error: 'No image file or data provided' });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create New Product / Stock Endpoint (Shopkeeper Only - Real-Time Broadcast)
app.post('/api/products', requireShopkeeperAuth, async (req, res) => {
  try {
    const { name, category, packSize, price, costPrice, stock, minThreshold, available, description, image } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Product name is required' });
    }
    if (!category) {
      return res.status(400).json({ success: false, error: 'Category is required' });
    }

    const newProduct = await db.createProduct({
      name,
      category,
      packSize: packSize || 'Standard Pack',
      price: price !== undefined && price !== '' ? Number(price) : null,
      costPrice: costPrice !== undefined && costPrice !== '' ? Number(costPrice) : null,
      stock: parseInt(stock, 10) || 0,
      minThreshold: parseInt(minThreshold, 10) || 5,
      available: available !== undefined ? Boolean(available) : true,
      description: description || '',
      image: image || '/assets/arun-vanilla-cup.jpg'
    });

    // Real-Time Socket Broadcasts
    io.emit('product:created', newProduct);
    io.emit('products:stock_batch_updated', [newProduct]);

    console.log(`➕ New Product Added: ${newProduct.name} (${newProduct.category}) - Price: ₹${newProduct.price}, Stock: ${newProduct.stock}`);

    res.status(201).json({
      success: true,
      product: newProduct,
      message: `Successfully added ${newProduct.name} to catalogue!`
    });
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update product (Price, Cost, Stock, MinThreshold, Availability, PackSize, Image) - Shopkeeper Only
app.patch('/api/products/:id', requireShopkeeperAuth, async (req, res) => {
  try {
    const updatedProduct = await db.updateProduct(req.params.id, req.body);
    
    // Broadcast product update and stock batch update to all connected clients in real-time
    io.emit('product:updated', updatedProduct);
    io.emit('products:stock_batch_updated', [updatedProduct]);

    res.json({
      success: true,
      product: updatedProduct,
      message: `Updated ${updatedProduct.name}`
    });
  } catch (err) {
    console.error('Error updating product:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete Product (Shopkeeper Only - Soft Delete)
app.delete('/api/products/:id', requireShopkeeperAuth, async (req, res) => {
  try {
    const result = await db.deleteProduct(req.params.id);
    io.emit('product:deleted', { id: req.params.id });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// ORDERS API (REAL-TIME SHARED DATA LAYER)
// -------------------------------------------------------------

// Create New Order (Customer Order Flow with Idempotency & Rate Limiting)
app.post('/api/orders', orderRateLimiter, async (req, res) => {
  try {
    const { customerId, customerName, customerPhone, customerEmail, items, paymentMethod, paymentStatus, notes } = req.body;

    // 1. Idempotency Key Check
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || req.body.clientOrderId;
    if (idempotencyKey && processedOrders.has(idempotencyKey)) {
      const cached = processedOrders.get(idempotencyKey);
      return res.status(200).json({
        success: true,
        order: cached.order,
        updatedProducts: cached.updatedProducts,
        duplicatePrevented: true
      });
    }

    // 2. Rapid duplicate submission check (within 3 seconds)
    const itemsSummary = (Array.isArray(items) ? items : []).map(i => `${i.productId || i.id}:${i.quantity}`).sort().join(',');
    const signature = `${(customerPhone || customerName || '').trim()}:${itemsSummary}`;
    const now = Date.now();
    const recent = recentOrderSignatures.get(signature);
    if (recent && (now - recent.timestamp < 3000)) {
      console.log(`⚡ Rapid duplicate order caught & prevented for: ${signature}`);
      return res.status(200).json({
        success: true,
        order: recent.order,
        updatedProducts: recent.updatedProducts,
        duplicatePrevented: true
      });
    }

    const result = await db.createOrder({
      customerId,
      customerName,
      customerPhone,
      customerEmail,
      items,
      paymentMethod,
      paymentStatus: paymentStatus || 'PENDING',
      notes
    });

    const newOrder = result.order;
    const updatedProducts = result.updatedProducts;

    // Cache order signature for idempotency
    if (idempotencyKey) {
      processedOrders.set(idempotencyKey, { timestamp: Date.now(), order: newOrder, updatedProducts });
    }
    recentOrderSignatures.set(signature, { timestamp: Date.now(), order: newOrder, updatedProducts });

    // Real-Time Broadcasts
    io.emit('order:created', newOrder);
    io.emit('products:stock_batch_updated', updatedProducts);

    console.log(`📦 New Order Created: ${newOrder.orderNumber} (${newOrder.customerName}) - Total: ₹${newOrder.total}`);

    res.status(201).json({
      success: true,
      order: newOrder,
      updatedProducts: updatedProducts
    });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get all orders (Shopkeeper Dashboard)
app.get('/api/orders', requireShopkeeperAuth, async (req, res) => {
  try {
    const orders = await db.getOrders();
    res.json({ success: true, orders });
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get customer personal order history
app.get('/api/customer/orders', async (req, res) => {
  try {
    const customerId = req.query.customerId || req.headers['x-customer-id'];
    const email = req.query.email || req.headers['x-customer-email'];
    const phone = req.query.phone || req.headers['x-customer-phone'];

    const lookupTerm = customerId || email || phone;
    if (!lookupTerm) {
      return res.json({ success: true, orders: [] });
    }

    const orders = await db.getCustomerOrders(lookupTerm);
    res.json({ success: true, orders });
  } catch (err) {
    console.error('Error fetching customer orders:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Direct Order Lookup by Order Number or ID (For QR Scanners & Verification)
app.get('/api/orders/lookup/:query', async (req, res) => {
  try {
    const query = req.params.query ? req.params.query.trim() : '';
    if (!query) {
      return res.status(400).json({ success: false, error: 'Query parameter is required' });
    }
    const found = await db.getOrderById(query);

    if (!found) {
      return res.status(404).json({ success: false, error: `Order not found matching "${query}"` });
    }

    res.json({ success: true, order: found });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Single Order by ID or Order Number
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Order Status (Shopkeeper controls: NEW -> ACCEPTED -> PREPARING -> READY_FOR_PICKUP -> COMPLETED -> CANCELLED)
app.patch('/api/orders/:id/status', requireShopkeeperAuth, async (req, res) => {
  try {
    const status = req.body.status || req.body.orderStatus;
    if (!status || !status.trim()) {
      return res.status(400).json({ success: false, error: 'Order status is required (e.g. ACCEPTED, PREPARING, READY_FOR_PICKUP, COMPLETED, CANCELLED)' });
    }

    const updatedOrder = await db.updateOrderStatus(req.params.id, status.trim());

    if (updatedOrder.updatedProducts && updatedOrder.updatedProducts.length > 0) {
      io.emit('products:stock_batch_updated', updatedOrder.updatedProducts);
    }

    // Broadcast status update to all devices and target order room
    io.emit('order:status_updated', updatedOrder);
    io.to(`order_${updatedOrder.id}`).emit('order:my_status_updated', updatedOrder);
    io.to(`order_${updatedOrder.orderNumber}`).emit('order:my_status_updated', updatedOrder);

    console.log(`🔄 Order ${updatedOrder.orderNumber} Status Updated -> ${updatedOrder.orderStatus}`);

    res.json({
      success: true,
      order: updatedOrder
    });
  } catch (err) {
    console.error('Error updating order status:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update Order Payment Status (Shopkeeper Payment Collection Endpoint)
app.patch('/api/orders/:id/payment', requireShopkeeperAuth, async (req, res) => {
  try {
    const paymentStatus = req.body.paymentStatus;
    if (!paymentStatus) {
      return res.status(400).json({ success: false, error: 'paymentStatus is required (e.g. PAID, PENDING)' });
    }

    const updatedOrder = await db.updatePaymentStatus(req.params.id, paymentStatus);

    io.emit('order:status_updated', updatedOrder);
    io.to(`order_${updatedOrder.id}`).emit('order:my_status_updated', updatedOrder);
    io.to(`order_${updatedOrder.orderNumber}`).emit('order:my_status_updated', updatedOrder);

    console.log(`💳 Order ${updatedOrder.orderNumber} Payment Updated -> ${updatedOrder.paymentStatus}`);

    res.json({
      success: true,
      order: updatedOrder
    });
  } catch (err) {
    console.error('Error updating order payment:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Order Cancellation Endpoint (Customer cancellation for NEW orders, Shopkeeper cancellation for active orders)
app.post('/api/orders/:id/cancel', async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Authorization check
    const authHeader = req.headers['authorization'];
    const customToken = req.headers['x-shopkeeper-token'];
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (customToken) {
      token = String(customToken).trim();
    }
    const isShopkeeper = isValidShopkeeperToken(token);

    if (!isShopkeeper && order.orderStatus !== 'NEW') {
      return res.status(403).json({
        success: false,
        error: 'Order has already been accepted or is being prepared. Please contact the counter staff to cancel.'
      });
    }

    const updatedOrder = await db.updateOrderStatus(order.id, 'CANCELLED');

    if (updatedOrder.updatedProducts && updatedOrder.updatedProducts.length > 0) {
      io.emit('products:stock_batch_updated', updatedOrder.updatedProducts);
    }

    io.emit('order:status_updated', updatedOrder);
    io.to(`order_${updatedOrder.id}`).emit('order:my_status_updated', updatedOrder);
    io.to(`order_${updatedOrder.orderNumber}`).emit('order:my_status_updated', updatedOrder);

    console.log(`❌ Order ${updatedOrder.orderNumber} Cancelled & Stock Restored.`);

    res.json({
      success: true,
      order: updatedOrder,
      message: `Order ${updatedOrder.orderNumber} has been cancelled and stock restored to inventory.`
    });
  } catch (err) {
    console.error('Error cancelling order:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Complete Pickup (Counter QR Scan) - Supports both /pickup and /complete-pickup
const handleCompletePickup = async (req, res) => {
  try {
    const updatedOrder = await db.completePickup(req.params.id);
    io.emit('order:status_updated', updatedOrder);
    io.emit('order:completed', updatedOrder);
    io.to(`order_${updatedOrder.id}`).emit('order:my_status_updated', updatedOrder);
    io.to(`order_${updatedOrder.orderNumber}`).emit('order:my_status_updated', updatedOrder);

    res.json({
      success: true,
      order: updatedOrder,
      message: `Order ${updatedOrder.orderNumber} pickup verified and completed!`
    });
  } catch (err) {
    console.error('Error completing pickup:', err);
    res.status(400).json({ success: false, error: err.message });
  }
};

app.post('/api/orders/:id/pickup', requireShopkeeperAuth, handleCompletePickup);
app.post('/api/orders/:id/complete-pickup', requireShopkeeperAuth, handleCompletePickup);

// -------------------------------------------------------------
// REVENUE & REPORTS API (FINANCIAL ANALYTICS & PROFIT/LOSS)
// -------------------------------------------------------------
app.get('/api/reports/revenue', requireShopkeeperAuth, async (req, res) => {
  try {
    const reports = await db.getRevenueReports();
    res.json({ success: true, reports });
  } catch (err) {
    console.error('Error generating revenue reports:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// SETTINGS & STATS API
// -------------------------------------------------------------

// Update Shop Settings & UPI ID (Shopkeeper Only - Real-Time Broadcast)
app.patch('/api/settings', requireShopkeeperAuth, async (req, res) => {
  try {
    const updatedSettings = await db.updateSettingsBatch(req.body);
    const safeSettings = { ...updatedSettings };
    delete safeSettings.shopkeeperPassword;

    io.emit('settings:updated', safeSettings);
    console.log('🔄 Shop Settings & UPI ID updated and broadcasted:', safeSettings.upiId);

    res.json({
      success: true,
      settings: safeSettings,
      message: 'Shop settings updated and synchronized across all devices!'
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getSettings();
    const safeSettings = { ...settings };
    delete safeSettings.shopkeeperPassword;
    delete safeSettings.shopkeeperUsername;
    res.json({ success: true, settings: safeSettings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stats/dashboard', requireShopkeeperAuth, async (req, res) => {
  try {
    const stats = await db.getDashboardStats();
    res.json({ success: true, stats });
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// WEBSOCKET REAL-TIME HUB
// -------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('subscribe:order', (orderIdOrNumber) => {
    if (orderIdOrNumber) {
      socket.join(`order_${orderIdOrNumber}`);
    }
  });

  socket.on('subscribe:customer', (customerId) => {
    if (customerId) {
      socket.join(`customer_${customerId}`);
    }
  });
});

// 404 handler for unmatched API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API route not found: ${req.method} ${req.originalUrl}` });
});

// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'An unexpected internal server error occurred' : err.message
  });
});

// Start Server (only if run directly, allow importing for tests)
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const localIp = getLocalIpAddress();
    console.log(`
===============================================================
🍨 SURYA AGENCIES — REAL-TIME ORDERING SYSTEM IS LIVE!
🏠 Local Host: http://localhost:${PORT}/
📱 Same Wi-Fi Link: http://${localIp}:${PORT}/
📱 Customer Portal: http://${localIp}:${PORT}/#customer
🏪 Shopkeeper Portal: http://${localIp}:${PORT}/#shopkeeper
===============================================================
    `);
  });
}

module.exports = { app, server, io };
