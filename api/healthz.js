const { handleHealthz } = require('../lib/apiProxy');

module.exports = (req, res) => {
    handleHealthz(req, res);
};
