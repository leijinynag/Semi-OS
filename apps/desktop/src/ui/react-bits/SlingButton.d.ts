import type { ReactNode } from "react";

export interface SlingButtonProps {
  children?: ReactNode;
  onSend?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  padColor?: string;
  iconColor?: string;
  accentColor?: string;
  wellColor?: string;
  bandColor?: string;
  size?: number;
  strokeWidth?: number;
  armAt?: number;
  maxPull?: number;
  launchSpeed?: number;
  recoil?: number;
  flight?: number;
  particles?: number;
  spread?: number;
  axis?: "any" | "horizontal" | "vertical";
  tapSends?: boolean;
}
export default function SlingButton(props: SlingButtonProps): ReactNode;
