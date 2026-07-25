import Svg, {
  Defs,
  LinearGradient,
  Stop,
  Rect,
  Path,
  Circle,
} from 'react-native-svg';

/**
 * Keepr logomark rendered as the exact brand SVG (BACKLOG-2254).
 *
 * Rounded-square indigo gradient (#4F46E5 → #6D5DF0, diagonal) with the white
 * angular "K" strokes and the #F5A524 accent dot. Matches the portal/landing
 * AppMark 1:1 (512-unit viewBox, rx 116).
 */

interface BrandMarkProps {
  /** Rendered size in px (square). Default 60. */
  size?: number;
}

export default function BrandMark({ size = 60 }: BrandMarkProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" accessibilityLabel="Keepr">
      <Defs>
        <LinearGradient id="keeprMarkGradient" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#4F46E5" />
          <Stop offset="1" stopColor="#6D5DF0" />
        </LinearGradient>
      </Defs>
      <Rect width={512} height={512} rx={116} fill="url(#keeprMarkGradient)" />
      {/* White "K": vertical bar + two diagonal strokes */}
      <Path
        d="M156 178 L182 154 L208 178 L208 382 L156 382 Z"
        fill="#FFFFFF"
      />
      <Path
        d="M190 256 L300 382"
        stroke="#FFFFFF"
        strokeWidth={52}
        strokeLinecap="butt"
      />
      <Path
        d="M190 254 L292 176"
        stroke="#FFFFFF"
        strokeWidth={52}
        strokeLinecap="butt"
      />
      {/* Accent dot */}
      <Circle cx={352} cy={352} r={19} fill="#F5A524" />
    </Svg>
  );
}
