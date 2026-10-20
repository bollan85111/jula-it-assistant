/**
 * 部署配置（不含任何密钥，可安全提交到仓库）
 *
 * 说明：
 *   - 本文件只放"部署参数"，绝不要在这里写 API Key。
 *     Key 必须由服务端（代理）持有，或在本地构建时注入而不进版本库。
 *   - app.js 会读取 window.LLM_CONFIG 覆盖内置默认值。
 *
 * 两种模式：
 *   1) proxy 模式（推荐，密钥零泄露）
 *      window.LLM_CONFIG = {
 *        mode: "proxy",
 *        proxyBase: "https://<你的代理域名或IP:端口>/api"
 *      };
 *      需要在服务器上运行 llm-proxy.js，Key 放在其环境变量 ARK_API_KEY 里。
 *
 *   2) direct 模式（浏览器直连，Key 会随页面公开，不建议用于生产）
 *      window.LLM_CONFIG = {
 *        mode: "direct",
 *        base: "https://ark.cn-beijing.volces.com/api/v3",
 *        key: "<在此填入 API Key，务必不要提交该文件到公开仓库>",
 *        model: "doubao-lite"
 *      };
 */
window.LLM_CONFIG = {
  mode: "proxy",
  // 代理服务地址；部署 llm-proxy.js 后填入真实地址
  proxyBase: "https://llm.jula.com/api",
  // 直连模式兜底参数（mode 切为 direct 时生效）
  base: "https://ark.cn-beijing.volces.com/api/v3",
  model: "doubao-lite"
};
