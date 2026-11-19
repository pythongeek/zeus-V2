/**
 * Mighty Zeus brand logo (owner-supplied animated SVG emblem,
 * 2026-11-20): MIGHTY kicker banner in electric cyan over a
 * forged-gold ZEUS wordmark, rotating meander rings, laurel
 * wings and lightning emblems. The animation CSS (mzFloat,
 * ring rotations, sheen sweeps, edge tracers, spark nodes)
 * lives in src/index.css with the other game keyframes; a
 * prefers-reduced-motion rule stills it there. Wordmark type
 * is Cinzel / Cinzel Decorative from the self-hosted font kit.
 */
export function MightyZeusLogo({ className = "w-full max-w-[540px]" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center justify-center select-none ${className}`}>
      <svg viewBox="0 0 800 470" className="mighty-zeus-logo block h-auto w-full" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mighty Zeus Official Brand Logo">
      <defs>
      <radialGradient id="olympusAuraGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.48" />
      <stop offset="42%" stopColor="#F59E0B" stopOpacity="0.24" />
      <stop offset="75%" stopColor="#0284C7" stopOpacity="0.06" />
      <stop offset="100%" stopColor="#0284C7" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="shieldCoreGrad" cx="50%" cy="38%" r="58%">
      <stop offset="0%" stopColor="#1E3A8A" />
      <stop offset="52%" stopColor="#0F172A" />
      <stop offset="100%" stopColor="#050811" />
      </radialGradient>
      <linearGradient id="zeusGoldFace" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor="#FFFBEB" />
      <stop offset="18%" stopColor="#FDE047" />
      <stop offset="48%" stopColor="#F59E0B" />
      <stop offset="53%" stopColor="#D97706" />
      <stop offset="82%" stopColor="#FBBF24" />
      <stop offset="100%" stopColor="#78350F" />
      </linearGradient>
      <linearGradient id="zeusGoldRim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stopColor="#FEF9C3" />
      <stop offset="30%" stopColor="#FACC15" />
      <stop offset="65%" stopColor="#B45309" />
      <stop offset="100%" stopColor="#FDE68A" />
      </linearGradient>
      <linearGradient id="mightyElectricCyan" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor="#FFFFFF" />
      <stop offset="28%" stopColor="#E0F2FE" />
      <stop offset="56%" stopColor="#7DD3FC" />
      <stop offset="82%" stopColor="#38BDF8" />
      <stop offset="100%" stopColor="#0284C7" />
      </linearGradient>
      <linearGradient id="mightyEdgeRimGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stopColor="#38BDF8" />
      <stop offset="35%" stopColor="#FFFFFF" />
      <stop offset="50%" stopColor="#BAE6FD" />
      <stop offset="70%" stopColor="#FFFFFF" />
      <stop offset="100%" stopColor="#0EA5E9" />
      </linearGradient>
      <linearGradient id="mightyPlateBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor="#020617" />
      <stop offset="50%" stopColor="#071326" />
      <stop offset="100%" stopColor="#02040A" />
      </linearGradient>
      <linearGradient id="lightningCoreGrad" x1="20%" y1="0%" x2="80%" y2="100%">
      <stop offset="0%" stopColor="#FFFFFF" />
      <stop offset="35%" stopColor="#E0F2FE" />
      <stop offset="70%" stopColor="#38BDF8" />
      <stop offset="100%" stopColor="#0284C7" />
      </linearGradient>
      <linearGradient id="metallicSheenGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
      <stop offset="45%" stopColor="#FFFBEB" stopOpacity="0.72" />
      <stop offset="55%" stopColor="#FFFFFF" stopOpacity="0.9" />
      <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
      </linearGradient>
      <filter id="heavyDropShadow" x="-20%" y="-20%" width="140%" height="145%">
      <feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#02040A" floodOpacity="0.92" />
      <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000000" floodOpacity="0.85" />
      </filter>
      <filter id="electricGlow" x="-35%" y="-35%" width="170%" height="170%">
      <feGaussianBlur stdDeviation="5" result="blur1" />
      <feGaussianBlur stdDeviation="14" result="blur2" />
      <feMerge>
      <feMergeNode in="blur2" />
      <feMergeNode in="blur1" />
      <feMergeNode in="SourceGraphic" />
      </feMerge>
      </filter>
      <filter id="goldEmbossGlow" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#F59E0B" floodOpacity="0.45" />
      </filter>
      <filter id="mightyCyanAura" x="-25%" y="-35%" width="150%" height="170%">
      <feDropShadow dx="0" dy="0" stdDeviation="4.5" floodColor="#38BDF8" floodOpacity="0.9" />
      <feDropShadow dx="0" dy="0" stdDeviation="11" floodColor="#0284C7" floodOpacity="0.75" />
      </filter>
      <clipPath id="mightyTextClip">
      <text x="400" y="150" textAnchor="middle" fontFamily="'Cinzel', Georgia, serif" fontWeight="900" fontSize="37" letterSpacing="11">MIGHTY</text>
      </clipPath>
      <clipPath id="zeusTextClip">
      <text x="400" y="312" textAnchor="middle" fontFamily="'Cinzel Decorative', 'Cinzel', Georgia, serif" fontWeight="900" fontSize="146" letterSpacing="10">ZEUS</text>
      </clipPath>
      </defs>
      <circle cx="400" cy="235" r="245" fill="url(#olympusAuraGrad)" className="olympian-aura" />
      <g className="meander-ring-outer" opacity="0.88">
      <circle cx="400" cy="235" r="204" fill="none" stroke="url(#zeusGoldRim)" strokeWidth="2.5" strokeDasharray="18 8 4 8" />
      <circle cx="400" cy="235" r="194" fill="none" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="6 14" opacity="0.7" />
      <polygon points="400,24 407,33 400,42 393,33" fill="#FDE047" />
      <polygon points="400,428 407,437 400,446 393,437" fill="#FDE047" />
      <polygon points="189,235 198,228 207,235 198,242" fill="#38BDF8" />
      <polygon points="593,235 602,228 611,235 602,242" fill="#38BDF8" />
      </g>
      <g className="meander-ring-inner" opacity="0.9">
      <circle cx="400" cy="235" r="176" fill="url(#shieldCoreGrad)" stroke="url(#zeusGoldRim)" strokeWidth="4" />
      <circle cx="400" cy="235" r="165" fill="none" stroke="#F59E0B" strokeWidth="1.5" strokeDasharray="12 6" opacity="0.75" />
      </g>
      <g filter="url(#heavyDropShadow)">
      <path d="M224 275 C168 258, 128 214, 112 162 C138 176, 162 196, 182 222 C164 188, 152 152, 150 116 C176 138, 196 168, 210 202 C202 172, 200 142, 206 112 C222 142, 232 176, 238 212 Z" fill="url(#zeusGoldFace)" stroke="#451A03" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M228 296 C178 292, 136 270, 108 232 C136 238, 164 248, 190 264 Z" fill="url(#zeusGoldRim)" stroke="#451A03" strokeWidth="2" />
      <path d="M576 275 C632 258, 672 214, 688 162 C662 176, 638 196, 618 222 C636 188, 648 152, 650 116 C624 138, 604 168, 590 202 C598 172, 600 142, 594 112 C578 142, 568 176, 562 212 Z" fill="url(#zeusGoldFace)" stroke="#451A03" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M572 296 C622 292, 664 270, 692 232 C664 238, 636 248, 610 264 Z" fill="url(#zeusGoldRim)" stroke="#451A03" strokeWidth="2" />
      </g>
      <g className="zeus-bolt-group" filter="url(#electricGlow)">
      <polygon points="418,36 368,184 408,184 378,292 444,158 402,158" fill="url(#lightningCoreGrad)" stroke="#FFFFFF" strokeWidth="2" strokeLinejoin="round" />
      <polygon points="414,344 384,412 406,412 388,452 432,392 408,392" fill="url(#lightningCoreGrad)" stroke="#FFFFFF" strokeWidth="1.8" strokeLinejoin="round" />
      <polyline points="172,196 206,214 192,232 228,248" fill="none" stroke="#7DD3FC" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="628,196 594,214 608,232 572,248" fill="none" stroke="#7DD3FC" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g filter="url(#heavyDropShadow)">
      <path d="M226 135 L254 108 L546 108 L574 135 L552 164 L248 164 Z" fill="url(#mightyPlateBg)" stroke="url(#zeusGoldRim)" strokeWidth="3.2" strokeLinejoin="round" />
      <path d="M233 135 L257 113 L543 113 L567 135 L548 159 L252 159 Z" fill="none" stroke="#0284C7" strokeWidth="1.6" opacity="0.85" />
      <path
      d="M233 135 L257 113 L543 113 L567 135 L548 159 L252 159 Z"
      fill="none"
      stroke="#E0F2FE"
      strokeWidth="2.6"
      strokeLinecap="round"
      className="mighty-banner-tracer"
      filter="url(#mightyCyanAura)"
      />
      <polygon points="244,135 253,126 262,135 253,144" fill="#38BDF8" stroke="#FFFFFF" strokeWidth="1.2" />
      <polygon points="538,135 547,126 556,135 547,144" fill="#38BDF8" stroke="#FFFFFF" strokeWidth="1.2" />
      <text
      x="400"
      y="154"
      textAnchor="middle"
      fontFamily="'Cinzel', Georgia, serif"
      fontWeight="900"
      fontSize="37"
      letterSpacing="11"
      fill="#02040A"
      stroke="#02040A"
      strokeWidth="9"
      strokeLinejoin="round"
      >MIGHTY</text>
      <text
      x="400"
      y="152"
      textAnchor="middle"
      fontFamily="'Cinzel', Georgia, serif"
      fontWeight="900"
      fontSize="37"
      letterSpacing="11"
      fill="#0C4A6E"
      stroke="#0369A1"
      strokeWidth="5"
      strokeLinejoin="round"
      >MIGHTY</text>
      <text
      x="400"
      y="150"
      textAnchor="middle"
      fontFamily="'Cinzel', Georgia, serif"
      fontWeight="900"
      fontSize="37"
      letterSpacing="11"
      fill="url(#mightyElectricCyan)"
      stroke="url(#mightyEdgeRimGrad)"
      strokeWidth="1.6"
      strokeLinejoin="round"
      filter="url(#mightyCyanAura)"
      >MIGHTY</text>
      <text
      x="400"
      y="150"
      textAnchor="middle"
      fontFamily="'Cinzel', Georgia, serif"
      fontWeight="900"
      fontSize="37"
      letterSpacing="11"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mighty-letter-edge-arc"
      >MIGHTY</text>
      <g clipPath="url(#mightyTextClip)">
      <rect x="180" y="108" width="75" height="60" fill="url(#metallicSheenGrad)" className="mighty-sheen-bar" />
      </g>
      <g filter="url(#mightyCyanAura)">
      <polygon points="282,118 285,123 290,126 285,129 282,134 279,129 274,126 279,123" fill="#FFFFFF" className="mighty-spark-node" style={{ animationDelay: "0s" }} />
      <polygon points="348,116 350,120 354,122 350,124 348,128 346,124 342,122 346,120" fill="#BAE6FD" className="mighty-spark-node" style={{ animationDelay: "0.55s" }} />
      <polygon points="452,116 454,120 458,122 454,124 452,128 450,124 446,122 450,120" fill="#BAE6FD" className="mighty-spark-node" style={{ animationDelay: "1.1s" }} />
      <polygon points="518,118 521,123 526,126 521,129 518,134 515,129 510,126 515,123" fill="#FFFFFF" className="mighty-spark-node" style={{ animationDelay: "1.65s" }} />
      <circle cx="268" cy="149" r="2.2" fill="#7DD3FC" className="mighty-spark-node" style={{ animationDelay: "0.35s" }} />
      <circle cx="532" cy="149" r="2.2" fill="#7DD3FC" className="mighty-spark-node" style={{ animationDelay: "1.35s" }} />
      </g>
      </g>
      <g filter="url(#heavyDropShadow)">
      <text x="400" y="324" textAnchor="middle" fontFamily="'Cinzel Decorative', 'Cinzel', Georgia, serif" fontWeight="900" fontSize="146" letterSpacing="10" fill="#04060C" stroke="#04060C" strokeWidth="22" strokeLinejoin="round">ZEUS</text>
      <text x="400" y="320" textAnchor="middle" fontFamily="'Cinzel Decorative', 'Cinzel', Georgia, serif" fontWeight="900" fontSize="146" letterSpacing="10" fill="#451A03" stroke="#451A03" strokeWidth="15" strokeLinejoin="round">ZEUS</text>
      <text x="400" y="316" textAnchor="middle" fontFamily="'Cinzel Decorative', 'Cinzel', Georgia, serif" fontWeight="900" fontSize="146" letterSpacing="10" fill="#92400E" stroke="#B45309" strokeWidth="9" strokeLinejoin="round">ZEUS</text>
      <text
      x="400"
      y="312"
      textAnchor="middle"
      fontFamily="'Cinzel Decorative', 'Cinzel', Georgia, serif"
      fontWeight="900"
      fontSize="146"
      letterSpacing="10"
      fill="url(#zeusGoldFace)"
      stroke="url(#zeusGoldRim)"
      strokeWidth="3.5"
      strokeLinejoin="round"
      filter="url(#goldEmbossGlow)"
      >ZEUS</text>
      <g clipPath="url(#zeusTextClip)">
      <rect x="0" y="175" width="110" height="175" fill="url(#metallicSheenGrad)" className="gold-sheen-bar" />
      </g>
      </g>
      <g filter="url(#heavyDropShadow)">
      <polygon points="400,72 414,92 400,104 386,92" fill="#38BDF8" stroke="#FEF08A" strokeWidth="2.5" />
      <polygon points="374,84 384,96 374,104 366,96" fill="url(#zeusGoldFace)" stroke="#451A03" strokeWidth="1.5" />
      <polygon points="426,84 434,96 426,104 416,96" fill="url(#zeusGoldFace)" stroke="#451A03" strokeWidth="1.5" />
      <path d="M276 346 L524 346 L504 366 L296 366 Z" fill="#070B14" stroke="url(#zeusGoldRim)" strokeWidth="2.8" />
      <polygon points="400,341 410,356 400,371 390,356" fill="#38BDF8" stroke="#FFFBEB" strokeWidth="2" />
      <path d="M312 356 L376 356" stroke="url(#zeusGoldFace)" strokeWidth="3" strokeLinecap="round" />
      <path d="M424 356 L488 356" stroke="url(#zeusGoldFace)" strokeWidth="3" strokeLinecap="round" />
      </g>
      </svg>
    </div>
  );
}
