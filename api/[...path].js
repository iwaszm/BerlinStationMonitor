const { handleApiProxy } = require('../lib/apiProxy');

module.exports = (req, res) => {
    const parsedUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    handleApiProxy(req, res, parsedUrl);
};
