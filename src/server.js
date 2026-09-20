const config = require('./config');
const { createStore } = require('./db/store');
const { createApp } = require('./app');

const app = createApp(createStore(config.dataFile));

app.listen(config.port, () => {
  console.log(`API server listening on port ${config.port}`);
});
