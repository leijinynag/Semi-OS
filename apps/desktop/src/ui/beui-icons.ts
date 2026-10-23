/**
 * BeUI 原组件的图标兼容层：保留上游组件 API，只在此映射到项目统一的 Phosphor。
 * 业务代码继续使用 icons.ts 的领域名称，不引入第二套图标依赖。
 */
export {
  CaretDown as ChevronDown,
  Check,
  WarningCircle as CircleAlert,
  CircleNotch as LoaderCircle,
  ShieldCheck,
  X,
  Prohibit as Ban,
  BracketsCurly as Braces,
  CheckCircle as CircleCheck,
  XCircle as CircleX,
  Copy,
  ArrowCounterClockwise as RotateCcw,
  TerminalWindow as SquareTerminal,
  Wrench,
  BookOpenText,
  ArrowSquareOut as ExternalLink,
  Globe as Globe2,
  Circle,
  FileText,
  Image as ImageIcon,
  ChatText as MessageSquare,
  PencilLine,
  MagnifyingGlass as Search,
  Sparkle as Sparkles,
} from "@phosphor-icons/react";
