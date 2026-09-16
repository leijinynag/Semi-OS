/**
 * UI 只依赖语义化图标名称，不直接感知具体图标库。
 * 后续调整品牌风格或替换图标实现时，只需修改这一层映射。
 */
export {
  Robot as AgentIcon,
  Brain as MemoryIcon,
  ChatText as ConversationIcon,
  X as DismissIcon,
  Microphone as MicrophoneIcon,
  Pause as PauseIcon,
  GearSix as SettingsIcon,
  Sparkle as SkillsIcon,
  TreeStructure as TaskIcon,
} from "@phosphor-icons/react";
