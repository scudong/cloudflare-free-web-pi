/**
 * 知识库 / MCP 两个弹窗的懒加载入口（NERE-81）。
 *
 * 两者同一时刻只会开一个，放进同一个动态 import：首包不含这两个组件，
 * 第一次打开任一弹窗时加载一次 chunk，之后切到另一个不再请求。
 */

export { KnowledgePanel } from "./KnowledgePanel";
export { McpPanel } from "./McpPanel";
