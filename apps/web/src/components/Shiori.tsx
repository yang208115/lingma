import illustration from '../assets/shiori.png';

export function ShioriAvatar({ size = 'medium' }: { size?: 'small' | 'medium' | 'large' }) {
  return (
    <span className={`shiori-avatar shiori-avatar-${size}`} aria-hidden="true">
      <img src={illustration} alt="" width={1024} height={1536} decoding="async" />
    </span>
  );
}

export function ShioriIllustration() {
  return (
    <img
      className="shiori-illustration"
      src={illustration}
      alt="栞抱着星图手册，向你轻轻招手"
      width={1024}
      height={1536}
      decoding="async"
    />
  );
}
