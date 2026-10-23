import type { ReactNode } from "react";

export interface VoicePillProps {
  active?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  accentColor?: string;
  iconColor?: string;
  background?: string;
  size?: number;
  shape?: "pill" | "rounded";
  reach?: number;
  showTime?: boolean;
  waveform?: boolean;
  slideToCancel?: boolean;
  cancelDistance?: number;
  attack?: number;
  release?: number;
  sensitivity?: number;
  floor?: number;
  openDuration?: number;
  pressScale?: number;
  mode?: "auto" | "hold" | "toggle";
  holdAfter?: number;
  reactive?: "external" | "simulated";
  level?: number;
  onStart?: (event: { source: string }) => void;
  onStop?: (event: { reason: string; duration: number }) => void;
}
export default function VoicePill(props: VoicePillProps): ReactNode;
