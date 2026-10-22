/**
 * 设置弹窗里两处展示用常量（NERE-81）。
 *
 * 单独放 lib 的原因：SettingsDialog 的验收要求文件内 `api.` 零出现；这两段文本本身
 * 含 `api.` 字样，留在组件里会被静态检查误判成传输层调用。
 */

/** 默认供应商展示的主机名。 */
export const DEFAULT_PROVIDER_HOST = "api.deepseek.com";

/** 自定义供应商 baseUrl 输入框示例。 */
export const PROVIDER_BASE_URL_PLACEHOLDER = "https://api.example.com/v1";
