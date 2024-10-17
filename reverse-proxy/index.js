const express = require('express');
const httpProxy = require('http-proxy');

const app = express();
const PORT = 3000;

const BASE_PATH = 'https://deployerrr-outputs.s3.us-east-1.amazonaws.com/dist';

const proxy = httpProxy.createProxy();

app.use((req, res) => {
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];

    // Check if the subdomain is 'deployrrr'
    if (subdomain === 'deployrrr') {
        return res.send('No reverse proxying for the "deployrrr" subdomain.');
    }

    // Construct the target URL
    const resolvesTo = `${BASE_PATH}/${subdomain}`;

    // Proxy the request
    return proxy.web(req, res, { target: resolvesTo, changeOrigin: true });
});

// Handle proxy requests
proxy.on('proxyReq', (proxyReq, req, res) => {
    const url = req.url;
    if (url === '/') {
        proxyReq.path += 'index.html'; // Add 'index.html' if the request is for the root
    }
});

// Add a response interceptor to set the correct Content-Type header
proxy.on('proxyRes', (proxyRes, req, res) => {
    if (proxyRes.headers['content-type']) {
        res.set('Content-Type', proxyRes.headers['content-type']);
    }
});

app.listen(PORT, () => console.log(`Reverse Proxy Running on port ${PORT}`));
