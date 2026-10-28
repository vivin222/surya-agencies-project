/**
 * SURYA AGENCIES — REVIEW 3 MASTER COMPLETION VERIFICATION SUITE
 * 
 * Comprehensive Automated Verification covering:
 * Category A: Core Business Functionality & Stock Integrity
 * Category B: Security, Boundaries & Input Sanitization
 * Category C: Concurrency, Reliability & Error Recovery
 */

process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('path').join(__dirname, 'test_icecream.sqlite');

const assert = require('assert');
const http = require('http');
const db = require('./db');
const { app, server } = require('./server');

const TEST_PORT = 3188;
const BASE_URL = `http://localhost:${TEST_PORT}`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, options);
  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
  } else {
    data = await res.text();
  }
  return { status: res.status, headers: res.headers, data };
}

async function runReview3TestSuite() {
  console.log('====================================================================');
  console.log('🍨 SURYA AGENCIES — REVIEW 3 FINAL COMPLETION VERIFICATION SUITE');
  console.log('====================================================================\n');

  // Start HTTP Server on isolated test port
  await new Promise(resolve => server.listen(TEST_PORT, resolve));
  console.log(`📡 Test Server running on ${BASE_URL} (Isolated DB: test_icecream.sqlite)\n`);

  let totalTests = 0;
  let passedTests = 0;

  async function test(name, fn) {
    totalTests++;
    try {
      await fn();
      passedTests++;
      console.log(`✓ TEST ${totalTests}: ${name} -> PASS`);
    } catch (err) {
      console.error(`✗ TEST ${totalTests}: ${name} -> FAIL:`, err.message);
      throw err;
    }
  }

  try {
    // Baseline clean setup
    await db.ready;
    await db.resetAllData();

    // ========================================================================
    // CATEGORY A: CORE FUNCTIONALITY & STATE MACHINE
    // ========================================================================
    console.log('\n--- CATEGORY A: CORE FUNCTIONALITY & STATE MACHINE ---\n');

    await test('Server Startup & Health Endpoint (/health & /api/health)', async () => {
      const res = await request('/health');
      assert.strictEqual(res.status, 200, 'Health endpoint should return 200 OK');
      assert.strictEqual(res.data.status, 'ok');
      assert.strictEqual(res.data.database, 'connected');
      assert(res.data.uptime >= 0, 'Uptime should be reported');

      const apiRes = await request('/api/health');
      assert.strictEqual(apiRes.status, 200);
      assert.strictEqual(apiRes.data.status, 'ok');
    });

    await test('Public Product Catalog Retrieval (95+ items across 8 categories)', async () => {
      const res = await request('/api/products');
      assert.strictEqual(res.status, 200);
      assert(res.data.success);
      assert(Array.isArray(res.data.products));
      assert(res.data.products.length >= 95, `Expected >= 95 products, got ${res.data.products.length}`);
      
      const categories = [...new Set(res.data.products.map(p => p.category))];
      assert(categories.length >= 8, `Expected >= 8 categories, got ${categories.length}`);
    });

    await test('Split-Stock Attribute Exposure (totalStock, onlineStock, walkInStock)', async () => {
      const res = await request('/api/products');
      const prod = res.data.products[0];
      assert(prod.totalStock !== undefined, 'totalStock must be exposed');
      assert(prod.onlineStock !== undefined, 'onlineStock must be exposed');
      assert(prod.walkInStock !== undefined, 'walkInStock must be exposed');
      assert.strictEqual(prod.totalStock, prod.stock, 'totalStock must equal stock');
    });

    await test('Shopkeeper Authentication (Username & Password)', async () => {
      const res = await request('/api/auth/shopkeeper/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'surya_agencies', password: 'suryaiceavi23' })
      });
      assert.strictEqual(res.status, 200);
      assert(res.data.success);
      assert(res.data.token && res.data.token.startsWith('surya_sk_'), 'Must return signed session token');
    });

    await test('Shopkeeper Backward-Compatible Authentication (PIN 1234)', async () => {
      const res = await request('/api/auth/shopkeeper/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' })
      });
      assert.strictEqual(res.status, 200);
      assert(res.data.success);
      assert(res.data.token);
    });

    // Acquire valid shopkeeper token for authenticated tests
    const authLogin = await request('/api/auth/shopkeeper/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'surya_agencies', password: 'suryaiceavi23' })
    });
    const skToken = authLogin.data.token;

    await test('Order Creation with Atomic Inventory Deduction', async () => {
      const prodsRes = await request('/api/products');
      const targetProd = prodsRes.data.products.find(p => p.stock > 10) || prodsRes.data.products[0];
      const initialStock = targetProd.stock;

      const orderRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Aarav Sundaram',
          customerPhone: '9840011223',
          items: [{ productId: targetProd.id, quantity: 2, name: targetProd.name, price: targetProd.price }],
          paymentMethod: 'upi',
          paymentStatus: 'PAID'
        })
      });

      assert.strictEqual(orderRes.status, 201);
      assert(orderRes.data.success);
      assert.strictEqual(orderRes.data.order.customerName, 'Aarav Sundaram');

      const updatedProdRes = await request(`/api/products/${targetProd.id}`);
      assert.strictEqual(updatedProdRes.data.product.stock, initialStock - 2, 'Stock must decrease by 2');
    });

    await test('Order Token Generation & Formatting (#A001 - #Z999)', async () => {
      const prodsRes = await request('/api/products');
      const targetProd = prodsRes.data.products[0];

      const orderRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Token Tester',
          customerPhone: '9840099887',
          items: [{ productId: targetProd.id, quantity: 1, name: targetProd.name, price: targetProd.price }]
        })
      });

      const orderNumber = orderRes.data.order.orderNumber;
      assert(/^#[A-Z]\d{3}$/.test(orderNumber), `Order number ${orderNumber} must match format #[A-Z]001`);
    });

    await test('Multi-Format Ticket Lookup (raw UUID, #Token, clean token, URL-encoded)', async () => {
      const prodsRes = await request('/api/products');
      const targetProd = prodsRes.data.products[0];

      const orderRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Lookup Tester',
          customerPhone: '9840077665',
          items: [{ productId: targetProd.id, quantity: 1, name: targetProd.name, price: targetProd.price }]
        })
      });

      const ord = orderRes.data.order;
      const cleanToken = ord.orderNumber.replace('#', '');

      const byUuid = await request(`/api/orders/${ord.id}`);
      assert.strictEqual(byUuid.status, 200);

      const byHashToken = await request(`/api/orders/lookup/${encodeURIComponent(ord.orderNumber)}`);
      assert.strictEqual(byHashToken.status, 200);

      const byCleanToken = await request(`/api/orders/lookup/${cleanToken}`);
      assert.strictEqual(byCleanToken.status, 200);
      assert.strictEqual(byCleanToken.data.order.id, ord.id);
    });

    await test('5-Step Order Lifecycle Flow (NEW -> ACCEPTED -> PREPARING -> READY_FOR_PICKUP -> COMPLETED)', async () => {
      const prodsRes = await request('/api/products');
      const targetProd = prodsRes.data.products[0];

      const orderRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Lifecycle Tester',
          customerPhone: '9840033221',
          items: [{ productId: targetProd.id, quantity: 1, name: targetProd.name, price: targetProd.price }]
        })
      });
      const orderId = orderRes.data.order.id;

      // NEW -> ACCEPTED
      const step1 = await request(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${skToken}` },
        body: JSON.stringify({ status: 'ACCEPTED' })
      });
      assert.strictEqual(step1.data.order.orderStatus, 'ACCEPTED');

      // ACCEPTED -> PREPARING
      const step2 = await request(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${skToken}` },
        body: JSON.stringify({ status: 'PREPARING' })
      });
      assert.strictEqual(step2.data.order.orderStatus, 'PREPARING');

      // PREPARING -> READY_FOR_PICKUP
      const step3 = await request(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${skToken}` },
        body: JSON.stringify({ status: 'READY_FOR_PICKUP' })
      });
      assert.strictEqual(step3.data.order.orderStatus, 'READY_FOR_PICKUP');

      // READY_FOR_PICKUP -> COMPLETED (Counter Pickup)
      const step4 = await request(`/api/orders/${orderId}/pickup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${skToken}` }
      });
      assert.strictEqual(step4.data.order.orderStatus, 'COMPLETED');
      assert.strictEqual(step4.data.order.paymentStatus, 'PAID');
    });

    await test('Terminal State Guard: Rejection of Modifications on COMPLETED Order', async () => {
      const ordersRes = await request('/api/orders', {
        headers: { 'Authorization': `Bearer ${skToken}` }
      });
      const completedOrder = ordersRes.data.orders.find(o => o.orderStatus === 'COMPLETED');
      assert(completedOrder, 'Must have a completed order');

      const attempt = await request(`/api/orders/${completedOrder.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${skToken}` },
        body: JSON.stringify({ status: 'PREPARING' })
      });
      assert.strictEqual(attempt.status, 400);
      assert(attempt.data.error.includes('already COMPLETED'));
    });

    await test('Order Cancellation & Atomic Stock Restoration', async () => {
      const prodsRes = await request('/api/products');
      const targetProd = prodsRes.data.products[1];
      const stockBaseline = targetProd.stock;

      const orderRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Cancel Test Customer',
          customerPhone: '9840088990',
          items: [{ productId: targetProd.id, quantity: 3, name: targetProd.name, price: targetProd.price }]
        })
      });
      const orderId = orderRes.data.order.id;

      // Verify stock decreased
      let pCheck = await request(`/api/products/${targetProd.id}`);
      assert.strictEqual(pCheck.data.product.stock, stockBaseline - 3);

      // Cancel order
      const cancelRes = await request(`/api/orders/${orderId}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${skToken}` }
      });
      assert.strictEqual(cancelRes.status, 200);
      assert.strictEqual(cancelRes.data.order.orderStatus, 'CANCELLED');

      // Verify stock fully restored
      pCheck = await request(`/api/products/${targetProd.id}`);
      assert.strictEqual(pCheck.data.product.stock, stockBaseline, 'Stock must restore to exact baseline');
    });

    await test('Terminal State Guard: Rejection of Modifications on CANCELLED Order', async () => {
      const ordersRes = await request('/api/orders', {
        headers: { 'Authorization': `Bearer ${skToken}` }
      });
      const cancelledOrder = ordersRes.data.orders.find(o => o.orderStatus === 'CANCELLED');
      assert(cancelledOrder, 'Must have a cancelled order');

      const attempt = await request(`/api/orders/${cancelledOrder.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${skToken}` },
        body: JSON.stringify({ status: 'READY_FOR_PICKUP' })
      });
      assert.strictEqual(attempt.status, 400);
      assert(attempt.data.error.includes('already CANCELLED'));
    });

    await test('Payment Status Update API (PATCH /api/orders/:id/payment)', async () => {
      const prodsRes = await request('/api/products');
      const targetProd = prodsRes.data.products[0];

      const orderRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Payment Test Customer',
          customerPhone: '9840012399',
          items: [{ productId: targetProd.id, quantity: 1, name: targetProd.name, price: targetProd.price }],
          paymentMethod: 'pay_at_shop'
        })
      });
      const orderId = orderRes.data.order.id;
      assert.strictEqual(orderRes.data.order.paymentStatus, 'PENDING');

      // Shopkeeper marks cash payment collected
      const payRes = await request(`/api/orders/${orderId}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${skToken}` },
        body: JSON.stringify({ paymentStatus: 'PAID' })
      });
      assert.strictEqual(payRes.status, 200);
      assert.strictEqual(payRes.data.order.paymentStatus, 'PAID');
    });

    await test('Order Idempotency & Rapid Duplicate Order Prevention', async () => {
      const prodsRes = await request('/api/products');
      const targetProd = prodsRes.data.products[2];
      const stockBefore = targetProd.stock;

      const idempotencyKey = 'idem-' + Date.now();
      const payload = {
        customerName: 'Idempotent Customer',
        customerPhone: '9840055112',
        items: [{ productId: targetProd.id, quantity: 2, name: targetProd.name, price: targetProd.price }],
        paymentMethod: 'upi'
      };

      // First Request
      const firstRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(payload)
      });
      assert.strictEqual(firstRes.status, 201);
      const firstOrderId = firstRes.data.order.id;

      // Duplicate Request with identical key
      const duplicateRes = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(payload)
      });
      assert.strictEqual(duplicateRes.status, 200);
      assert.strictEqual(duplicateRes.data.order.id, firstOrderId, 'Must return same order ID');
      assert.strictEqual(duplicateRes.data.duplicatePrevented, true);

      // Verify stock was decremented ONLY ONCE (by 2, not by 4)
      const stockAfter = (await request(`/api/products/${targetProd.id}`)).data.product.stock;
      assert.strictEqual(stockAfter, stockBefore - 2, 'Stock must only be decremented once');
    });

    // ========================================================================
    // CATEGORY B: SECURITY AUDIT & VULNERABILITY PREVENTION
    // ========================================================================
    console.log('\n--- CATEGORY B: SECURITY AUDIT & VULNERABILITY PREVENTION ---\n');

    await test('Unauthorized Access Rejection on Protected Endpoints (401)', async () => {
      const protectedEndpoints = [
        { path: '/api/orders', method: 'GET' },
        { path: '/api/stats/dashboard', method: 'GET' },
        { path: '/api/reports/revenue', method: 'GET' },
        { path: '/api/products', method: 'POST', body: { name: 'Hack Prod', category: 'Cones' } },
        { path: '/api/settings', method: 'PATCH', body: { shopName: 'Hacked Shop' } }
      ];

      for (const ep of protectedEndpoints) {
        const res = await request(ep.path, {
          method: ep.method,
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined
        });
        assert.strictEqual(res.status, 401, `Endpoint ${ep.method} ${ep.path} must return 401 Unauthorized without token`);
        assert.strictEqual(res.data.success, false);
      }
    });

    await test('Forged Header Rejection: x-shopkeeper-verified alone cannot bypass auth', async () => {
      const res = await request('/api/orders', {
        headers: { 'x-shopkeeper-verified': 'true' }
      });
      assert.strictEqual(res.status, 401, 'Forged x-shopkeeper-verified without valid token must be rejected');
    });

    await test('Invalid Bearer Token Rejection: Arbitrary strings cannot bypass auth', async () => {
      const res = await request('/api/orders', {
        headers: { 'Authorization': 'Bearer arbitrary_invalid_token_12345' }
      });
      assert.strictEqual(res.status, 401, 'Arbitrary forged Bearer token must be rejected');
    });

    await test('Sanitized Settings Exposure: shopkeeperPassword & Username stripped from public GET /api/settings', async () => {
      const res = await request('/api/settings');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.settings.shopkeeperPassword, undefined, 'Password MUST NOT be exposed');
      assert.strictEqual(res.data.settings.shopkeeperUsername, undefined, 'Username MUST NOT be exposed publicly');
      assert(res.data.settings.shopName, 'Shop name should be present');
    });

    await test('Input Validation: Rejection of Negative Quantities', async () => {
      const prodsRes = await request('/api/products');
      const prod = prodsRes.data.products[0];

      const res = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Hacker',
          items: [{ productId: prod.id, quantity: -5, price: prod.price }]
        })
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.success, false);
    });

    await test('Input Validation: Rejection of Fractional / Float Quantities (e.g. 2.5)', async () => {
      const prodsRes = await request('/api/products');
      const prod = prodsRes.data.products[0];

      const res = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Fractional Hacker',
          items: [{ productId: prod.id, quantity: 2.5, price: prod.price }]
        })
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.success, false);
    });

    await test('Payment Fraud Prevention: Pay-at-shop cannot falsely claim PAID on creation', async () => {
      const prodsRes = await request('/api/products');
      const prod = prodsRes.data.products[0];

      const res = await request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Fraudster',
          items: [{ productId: prod.id, quantity: 1, price: prod.price }],
          paymentMethod: 'pay_at_shop',
          paymentStatus: 'PAID' // Attacker claims paid for cash order
        })
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.order.paymentStatus, 'PENDING', 'Server MUST override pay_at_shop status to PENDING');
    });

    await test('SQL Injection Safety: Parameterized Query Protection against Malicious Strings', async () => {
      const injectionPayloads = [
        "' OR '1'='1",
        "'; DROP TABLE products; --",
        "admin'--",
        "' UNION SELECT * FROM settings --"
      ];

      for (const payload of injectionPayloads) {
        const res = await request(`/api/orders/lookup/${encodeURIComponent(payload)}`);
        assert.strictEqual(res.status, 404, `SQL injection string "${payload}" must safely return 404, not crash`);
      }

      // Verify products table was NOT dropped
      const prods = await db.getProducts();
      assert(prods.length >= 95, 'Database must remain fully intact');
    });

    await test('Security Headers (nosniff, SAMEORIGIN, XSS-Protection)', async () => {
      const res = await request('/api/products');
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert(res.headers.get('x-xss-protection'));
    });

    // ========================================================================
    // CATEGORY C: RELIABILITY, CONCURRENCY & RECOVERY
    // ========================================================================
    console.log('\n--- CATEGORY C: RELIABILITY, CONCURRENCY & RECOVERY ---\n');

    await test('Concurrency & Overselling Prevention under Race Conditions', async () => {
      // Create a temporary product with exactly 3 items in stock
      const tempProd = await db.createProduct({
        name: 'Flash Sale Arun Cone',
        category: 'Cones',
        price: 45,
        stock: 3,
        available: true
      });

      // Fire 5 concurrent order requests, each requesting 2 units (Total requested: 10 units, Available: 3)
      const concurrentRequests = Array.from({ length: 5 }, (_, i) => 
        request('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerName: `Concurrent Customer ${i + 1}`,
            customerPhone: `984000000${i}`,
            items: [{ productId: tempProd.id, quantity: 2, price: 45 }]
          })
        })
      );

      const results = await Promise.all(concurrentRequests);
      const successes = results.filter(r => r.status === 201);
      const failures = results.filter(r => r.status === 400);

      // Exactly 1 order for 2 units should succeed; 4 should fail due to insufficient stock (3 - 2 = 1 left)
      assert.strictEqual(successes.length, 1, `Expected exactly 1 order to succeed, got ${successes.length}`);
      assert.strictEqual(failures.length, 4, `Expected 4 orders to fail due to stock depletion, got ${failures.length}`);

      const remainingProd = await db.getProductById(tempProd.id);
      assert.strictEqual(remainingProd.stock, 1, 'Final stock must be exactly 1, never negative');
    });

    await test('Non-Existent API Route Graceful 404 (JSON format)', async () => {
      const res = await request('/api/unknown/endpoint/route');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.data.success, false);
      assert(res.data.error.includes('not found'));
    });

    await test('Revenue Analytics & Dashboard Calculation Consistency', async () => {
      const statsRes = await request('/api/stats/dashboard', {
        headers: { 'Authorization': `Bearer ${skToken}` }
      });
      assert.strictEqual(statsRes.status, 200);
      assert(statsRes.data.stats.totalProducts >= 95);
      assert(statsRes.data.stats.ordersCompleted >= 1);
      assert(statsRes.data.stats.totalRevenue >= 0);

      const revRes = await request('/api/reports/revenue', {
        headers: { 'Authorization': `Bearer ${skToken}` }
      });
      assert.strictEqual(revRes.status, 200);
      assert(revRes.data.reports.allTime.totalRevenue >= 0);
    });

    console.log('\n====================================================================');
    console.log(`🎉 ALL ${passedTests} OF ${totalTests} REVIEW 3 TESTS PASSED WITH 100% SUCCESS!`);
    console.log('====================================================================\n');

  } finally {
    server.close();
  }
}

runReview3TestSuite().catch(err => {
  console.error('\n❌ REVIEW 3 TEST SUITE ENCOUNTERED UNEXPECTED ERROR:', err);
  process.exit(1);
});
