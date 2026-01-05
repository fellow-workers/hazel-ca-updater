const hazel = require("hazel-server");

module.exports = hazel({
  repo: process.env.REPO,
  token: process.env.GITHUB_TOKEN
});
