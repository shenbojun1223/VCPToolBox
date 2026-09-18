const path = require("path");
const { extractAgentDTO, extractGroupDTO } = require("./dto");

// 模拟桌面全量 Agent 配置（含手机端会拒收的字段）
const desktopAgent = {
  name: "Nova",
  systemPrompt: "[[OneRing::Nova::VCPChatSync::Only]]\\n{{Nova}}",
  model: "deepseek-flash",
  temperature: 1,
  contextTokenLimit: 100000,
  maxOutputTokens: 60000,
  streamOutput: true,
  uiCollapseStates: { identityCollapsed: true },
  customCss: "border: 1px solid red;",
  chatCss: ".message-bubble{}",
  promptMode: "original",
  advancedSystemPrompt: { blocks: [], hiddenBlocks: {} },
  top_p: null,
  top_k: null,
  avatarCalculatedColor: "rgb(166, 167, 177)",
  ttsVoicePrimary: "",
  ttsDirectorPrompts: [],
  presetSystemPrompt: "",
};

const dto = extractAgentDTO(desktopAgent);
const keys = Object.keys(dto).sort();
console.log("AGENT DTO KEYS:", JSON.stringify(keys));
console.log("AGENT DTO:", JSON.stringify(dto));

const expected = ["contextTokenLimit","maxOutputTokens","model","name","streamOutput","systemPrompt","temperature"].sort();
const ok = JSON.stringify(keys) === JSON.stringify(expected);
console.log("AGENT_WHITELIST_MATCH:", ok);

// 验证陌生字段确实被剔除
const forbidden = ["uiCollapseStates","customCss","chatCss","promptMode","advancedSystemPrompt","top_p","top_k","avatarCalculatedColor","ttsDirectorPrompts"];
const leaked = forbidden.filter((f) => f in dto);
console.log("LEAKED_FIELDS:", JSON.stringify(leaked));

// Group DTO 检查
const desktopGroup = { name: "G", members: ["a"], avatar: "avatar.png", customCss: "x", top_p: null };
const gdto = extractGroupDTO(desktopGroup);
console.log("GROUP DTO:", JSON.stringify(gdto));
console.log("GROUP DTO KEYS:", JSON.stringify(Object.keys(gdto).sort()));

console.log(ok && leaked.length === 0 ? "PROBE_PASS" : "PROBE_FAIL");