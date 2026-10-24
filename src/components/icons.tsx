// src/components/icons.tsx — 15px stroke icons for nav and controls.
// All inherit currentColor so they follow the ink tokens.

interface IconProps {
  size?: number;
}

function Svg({ size = 15, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 4h12M2 8h12M2 12h12" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
  </Svg>
);

export const IconAuto = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.5" y="3" width="13" height="9" rx="1.5" />
    <path d="M6 14h4M8 12v2" />
  </Svg>
);

export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12a6.5 6.5 0 1 1 11 0" />
    <path d="M8 12 11 7" />
  </Svg>
);

export const IconInbound = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2v8M5 7l3 3 3-3" />
    <path d="M3 13h10" />
  </Svg>
);

export const IconOutbound = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 14V6M5 9l3-3 3 3" />
    <path d="M3 3h10" />
  </Svg>
);

export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 2 6 3-6 3-6-3 6-3Z" />
    <path d="m2 8.5 6 3 6-3M2 11.5l6 3 6-3" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7 4.5 8.8 2.7a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2" />
    <path d="M9 11.5 7.2 13.3a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
  </Svg>
);

export const IconCloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5a3 3 0 0 1-.3-6A4 4 0 0 1 12 5.6a3.2 3.2 0 0 1 .4 6.9Z" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c-3.5 3.6-3.5 8.4 0 12 3.5-3.6 3.5-8.4 0-12Z" />
  </Svg>
);

export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 13.5h12" />
    <path d="M4 11V7M8 11V3.5M12 11V8.5" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

/** The brand mark: a goose-neck "g" reduced to two strokes. */
export const BrandMark = () => (
  <svg viewBox="0 0 20 20" className="brand-mark" aria-hidden="true">
    <rect x="1" y="1" width="18" height="18" rx="5" fill="var(--accent)" />
    <path
      d="M13.2 6.2a3.4 3.4 0 1 0 0 6.4M13.2 9.4H9.6"
      fill="none"
      stroke="#fff"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);
