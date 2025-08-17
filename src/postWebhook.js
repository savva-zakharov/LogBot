// src/postWebhook.js
// Minimal Discord-compatible webhook POST helper
const http = require('http');
const https = require('https');

function postToWebhook(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const opts = {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: { 'Content-Type': 'application/json' },
      };
      const req = (isHttps ? https : http).request(opts, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.from(d)));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, body });
          const err = new Error(`HTTP ${res.statusCode}: ${body}`);
          err.status = res.statusCode;
          err.body = body;
          reject(err);
        });
      });
      req.on('error', (e) => reject(e));
      const buf = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
      req.setHeader('Content-Length', Buffer.byteLength(buf));
      req.write(buf);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { postToWebhook };
