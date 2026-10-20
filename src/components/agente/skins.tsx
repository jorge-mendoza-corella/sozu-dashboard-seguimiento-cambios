/**
 * Apariencias ("skins") de GeorgIA. Todas comparten el mismo esqueleto y las
 * mismas clases de articulación (personaje.css las mueve igual), así que poses,
 * vuelos, antojos y expresiones funcionan con cualquiera:
 *
 *   cyborg      la original: media cara de acero y brazo robótico
 *   abuelo      inventor con canas y bigote (la referencia, en cartoon)
 *   heroe       superhéroe clásico, más joven
 *   chibi       cabezota y ojos enormes
 *   cientifico  greña blanca, goggles puestos y bata
 *   raton       ratón clásico de caricatura: orejotas, guantes y short rojo
 *   travieso    niño de pelo en picos y piel amarilla
 *   ramon       Ramón: barba corta, pelo hacia atrás, saco oscuro y camisa gris
 *   tomaso      Tomaso: lentes al aire, cara delgada, traje gris y camisa blanca
 *   licesita    Licesita: pelo lacio oscuro, collar y vestido verde azulado
 *   keity, abel, pablo, rodrigo, manuel: el equipo; sus rasgos van en RASGOS
 *
 * La elegida vive en `agente_config/acceso.skin` (la cambia el root en
 * Configuración → GeorgIA) y se comparte por un store chico para que todo
 * Personaje la use sin pasarla a mano.
 */
import { PALETA, type Skin } from "./skinsDatos";

/** Antojos en la mano del frente (personaje.css muestra el que toca y lo lleva a la boca). */
export function Antojos() {
  return (
    // ×1.9 sobre la mano (58,64): a tamaño real no se distinguían.
    <g transform="translate(58 64) scale(1.9) translate(-58 -64) translate(20 4)">
      {/* Contrarrotación (personaje.css): que el antojo quede derecho aunque el brazo gire. */}
      <g className="pj-antojos">
      <g className="pj-snack pj-snack--pizza">
        <path d="M33.6 60.6 L43 60.6 L38.6 70.6 Z" fill="#fcd34d" stroke="#d97706" strokeWidth="0.5" />
        <path d="M33.2 59.6 L43.4 59.6 L43 61.4 L33.6 61.4 Z" fill="#b45309" />
        <circle cx="37" cy="63.4" r="1.1" fill="#dc2626" />
        <circle cx="39.8" cy="63" r="0.9" fill="#dc2626" />
        <circle cx="38.6" cy="66.6" r="0.85" fill="#dc2626" />
      </g>
      <g className="pj-snack pj-snack--refresco">
        <path d="M39.8 55.4 L41.4 50.6" stroke="#f8fafc" strokeWidth="0.9" strokeLinecap="round" />
        <rect x="35.4" y="55.6" width="6" height="10" rx="1.3" fill="#dc2626" />
        <rect x="35.4" y="58.6" width="6" height="2.4" fill="#f8fafc" />
        <rect x="35.8" y="55.6" width="5.2" height="0.9" rx="0.4" fill="#cbd5e1" />
      </g>
      <g className="pj-snack pj-snack--helado">
        <path d="M35.8 60.8 L41.2 60.8 L38.5 69.6 Z" fill="#d97706" />
        <path d="M36.6 62.6 L40.4 62.6 M37.2 64.8 L39.8 64.8" stroke="#92400e" strokeWidth="0.4" />
        <circle cx="38.5" cy="59.4" r="2.8" fill="#f9a8d4" />
        <circle cx="38.5" cy="56.6" r="2.3" fill="#86efac" />
        <circle cx="39.4" cy="55.6" r="0.6" fill="#fff" opacity="0.8" />
      </g>
      </g>
    </g>
  );
}

/** Brazo del frente de carne y hueso (mismas articulaciones que el robótico: hombro 58,39 · codo 58.1,51.6). */
/** `desnudo`: sin manga (el oso se llevó la cobija y anda en calzones). */
export function BrazoHumano({ skin, desnudo = false }: { skin: Skin; desnudo?: boolean }) {
  const descubierto = desnudo || PALETA[skin].brazosDescubiertos;
  const manga = descubierto ? `url(#pj-piel-${skin})` : skin === "cientifico" ? "url(#pj-bata)" : `url(#pj-camisa-${skin})`;
  return (
    <g className="pj-brazo-robot">
      <path d="M55.2 38.6 C54.6 42.6 54.8 46.6 55.3 51 L60.9 51 C61.4 46.6 61.6 42.6 61 38.6 C59 36.8 57 36.8 55.2 38.6 Z" fill={manga} />
      <g className="pj-antebrazo">
        <circle cx="58.1" cy="51.4" r="2.9" fill={manga} />
        <path d="M55.4 51.2 C55.1 54.4 55.2 57.6 55.6 60.6 L60.6 60.6 C61 57.6 61.1 54.4 60.8 51.2 Z" fill={manga} />
        <path d="M55.4 58.6 C57.2 59.6 59.2 59.6 60.8 58.6 L60.6 61.2 C59 62 57.2 62 55.6 61.2 Z" fill={descubierto ? manga : "#6b727c"} />
        {/* Mano */}
        <path d="M55.2 61.2 C54.6 64.4 55.6 67.4 58.2 67.6 C60.8 67.8 61.8 65 61.2 61.2 Z" fill={PALETA[skin].mano ?? `url(#pj-piel-${skin})`} />
        <path d="M55.4 62.4 C54.2 63 54 64.6 55 65.4" fill="none" stroke={PALETA[skin].mano ? "#cbd5e1" : PALETA[skin].pielSolida} strokeWidth="1.3" strokeLinecap="round" />
        <Antojos />
      </g>
    </g>
  );
}

type Trazo = { d: string; fill: string; opacity?: number };

/**
 * Rasgos de las caras del equipo, en el espacio de los bocetos (centro 60,52).
 * Se pintan en orden: cara → pelo → (ojos, cejas) → lentes → nariz → barba →
 * bocas → bigote. Lo que no se indica, toma lo de siempre.
 */
const RASGOS: Partial<Record<Skin, {
  cara: string;
  peloAtras?: string;
  pelo: Trazo[];
  mechas?: { d: string; stroke: string };
  lentes?: { stroke: string; ancho: number };
  pestanas?: boolean;
  nariz?: "larga" | "ancha";
  barba?: Trazo[];
  bigote?: Trazo;
}>> = {
  keity: {
    cara: "M32 50 Q32 18 60 18 Q88 18 88 50 Q88 74 74 84 Q60 90 46 84 Q32 74 32 50Z",
    peloAtras: "M26 56 Q22 12 60 12 Q98 12 94 56 L98 112 Q86 117 78 109 L78 62 L42 62 L42 109 Q34 117 22 112 Z",
    pelo: [
      { d: "M30 54 Q28 16 60 14 Q92 16 90 54 Q88 34 76 27 Q66 23 61 26 Q56 23 46 27 Q34 34 30 54Z", fill: "#1c1917" },
      { d: "M30 50 Q27 80 33 108 L41 106 Q36 78 36.5 52Z M90 50 Q93 80 87 108 L79 106 Q84 78 83.5 52Z", fill: "#1c1917" },
    ],
    mechas: { d: "M61 26 Q70 22 82 32 M59 26 Q50 22 38 32", stroke: "#44403c" },
    lentes: { stroke: "#1f2937", ancho: 2.2 },
    pestanas: true,
  },
  abel: {
    cara: "M30 46 Q30 17 60 17 Q90 17 90 46 Q90 74 76 83 Q60 90 44 83 Q30 74 30 46Z",
    pelo: [
      { d: "M30 50 Q29 34 35 28 L37 48 Z M90 48 Q91 33 85 27 L83 46 Z", fill: "#1f2937", opacity: 0.55 },
      { d: "M31 44 Q28 13 60 10 Q91 11 89 40 Q86 26 74 23 Q60 19 46 24 Q37 29 34 44Z", fill: "#1f2937" },
    ],
    mechas: { d: "M42 20 Q56 12 76 16 M46 25 Q60 18 80 23 M83 24 Q86 30 87 36", stroke: "#6b7280" },
    nariz: "ancha",
    barba: [
      { d: "M32 56 Q32 77 44 84 Q60 91 76 84 Q88 77 88 56 L85 58 Q84 72 74 77 Q67 80 62 77 Q57 80 50 77 Q40 72 35 58 Z", fill: "#1f2937", opacity: 0.55 },
      { d: "M54 84 Q62 90 70 84 L68 81 Q62 83 56 81 Z", fill: "#111827", opacity: 0.6 },
    ],
    bigote: { d: "M50 74 Q56 70.5 62 72.5 Q68 70.5 74 74 Q69 75.6 62 74.6 Q55 75.6 50 74 Z", fill: "#111827", opacity: 0.7 },
  },
  pablo: {
    cara: "M31 46 Q31 17 60 17 Q89 17 89 46 Q89 72 76 82 Q60 89 44 82 Q31 72 31 46Z",
    pelo: [
      { d: "M31 50 Q30 34 36 28 L38 48 Z M89 48 Q90 33 84 27 L82 46 Z", fill: "#a1a1aa", opacity: 0.8 },
      { d: "M32 44 Q26 12 58 7 Q92 8 88 40 Q85 24 72 21 Q58 17 45 23 Q37 28 35 44Z", fill: "#3f3f46" },
    ],
    mechas: { d: "M40 18 Q56 8 78 13 M45 22 Q60 14 82 20 M38 28 Q42 22 48 19", stroke: "#a1a1aa" },
    nariz: "larga",
    barba: [
      { d: "M31 54 Q31 78 44 86 Q60 94 76 86 Q89 78 89 54 L86 56 Q85 72 74 77 Q67 80 62 77 Q57 80 50 77 Q39 72 34 56 Z", fill: "#57534e", opacity: 0.85 },
      { d: "M40 76 Q46 84 54 87 M70 87 Q78 84 84 76 M58 86 Q62 88 66 86", fill: "none", opacity: 1 },
    ],
    bigote: { d: "M49 74 Q56 69.6 62 72.4 Q68 69.6 75 74 Q69 76 62 74.8 Q55 76 49 74 Z", fill: "#44403c", opacity: 0.95 },
  },
  rodrigo: {
    cara: "M31 46 Q31 18 60 18 Q89 18 89 46 Q89 72 76 82 Q60 89 44 82 Q31 72 31 46Z",
    pelo: [
      { d: "M31 50 Q30 34 36 29 L38 48 Z M89 48 Q90 33 84 28 L82 46 Z", fill: "#111827", opacity: 0.45 },
      // Copete alto peinado hacia atrás
      { d: "M33 44 Q27 18 42 8 Q58 -2 80 4 Q95 12 88 40 Q86 27 77 23 Q63 17 48 21 Q38 27 35.5 44Z", fill: "#111827" },
    ],
    mechas: { d: "M42 13 Q58 2 80 8 M44 19 Q60 9 84 15 M48 24 Q62 16 82 22", stroke: "#4b5563" },
    nariz: "larga",
    barba: [
      // Línea fina por la mandíbula y candado
      { d: "M33 60 Q34 78 46 84 Q60 90 74 84 Q86 78 87 60 L85.4 61 Q84 76 73 81.6 Q60 87.4 47 81.6 Q36 76 34.6 61Z", fill: "#111827", opacity: 0.7 },
      { d: "M55 83 Q62 89 69 83 L67.6 80.6 Q62 83 56.4 80.6 Z", fill: "#111827", opacity: 0.85 },
      { d: "M60.4 81.4 Q62 84.6 63.6 81.4 Z", fill: "#111827", opacity: 0.9 },
    ],
    bigote: { d: "M49 74.4 Q55 69.4 62 72.4 Q69 69.4 75 74.4 Q70 74 66 74.6 Q63 74 62 75.2 Q61 74 58 74.6 Q54 74 49 74.4 Z", fill: "#111827", opacity: 0.95 },
  },
  manuel: {
    cara: "M29 48 Q29 18 60 18 Q91 18 91 48 Q91 75 77 84 Q60 91 43 84 Q29 75 29 48Z",
    pelo: [
      // Al ras, con pico en la frente
      { d: "M30 46 Q29 17 60 15 Q91 17 90 46 Q88 32 80 28 L63 30 L60 35 L57 30 L40 28 Q32 32 30 46Z", fill: "#111827", opacity: 0.8 },
    ],
    nariz: "ancha",
    barba: [
      { d: "M31 56 Q31 78 44 85 Q60 92 76 85 Q89 78 89 56 L86 58 Q85 72 74 77 Q67 80 62 77 Q57 80 50 77 Q39 72 34 58 Z", fill: "#1f2937", opacity: 0.4 },
      { d: "M54 84 Q62 90 70 84 L68 81 Q62 83 56 81 Z", fill: "#111827", opacity: 0.5 },
    ],
    bigote: { d: "M50 74 Q56 71 62 72.8 Q68 71 74 74 Q69 75.4 62 74.6 Q55 75.4 50 74 Z", fill: "#1f2937", opacity: 0.55 },
  },
};

/**
 * Cabeza cartoon (de frente, ¾ hacia la derecha) dibujada en el espacio de los
 * bocetos (centro 60,52) y reducida al cuello del esqueleto. Los elementos de
 * expresión usan las mismas clases que la cyborg (pj-ojo-abierto, pj-ceja--*,
 * pj-boca--*, pj-lagrimas…), así que personaje.css los prende y apaga igual.
 */
export function CabezaCartoon({ skin }: { skin: Exclude<Skin, "cyborg"> }) {
  const p = PALETA[skin];
  const piel = `url(#pj-piel-${skin})`;
  const r = RASGOS[skin];
  // Chibi: la cabeza crece sobre el cuello.
  const escala = skin === "chibi" ? "translate(49 31) scale(1.42) translate(-49 -31)" : undefined;
  const gogglesEnOjos = skin === "cientifico";
  // El ratón y el travieso no llevan goggles: se reconocen por la silueta.
  const sinGoggles = !!r || (["raton", "travieso", "ramon", "tomaso", "licesita"] as Skin[]).includes(skin);
  const labios = p.labios ?? "#7c3a1d";
  const ojo =
    skin === "chibi" ? { rx: 7.4, ry: 8.6, iris: 5, pupila: 2.4, brillo: 1.7 }
    : skin === "raton" ? { rx: 5, ry: 9, iris: 3.4, pupila: 2.6, brillo: 1 }
    : skin === "travieso" ? { rx: 8.4, ry: 8.4, iris: 2.2, pupila: 2.2, brillo: 0.8 }
    : { rx: 6, ry: 7, iris: 3.7, pupila: 1.8, brillo: 1.1 };
  return (
    <g className="pj-cabeza">
      {/* Cuello */}
      <path d="M45.6 28.6 C45.6 31.6 45.2 33.8 44.8 35.8 L51.4 35.8 C51 33.8 50.6 31.6 50.6 28.6 Z" fill={p.cuello ?? piel} />
      <g transform={escala}>
        <g transform="translate(49 17.5) scale(0.345) translate(-60 -52)">
          {/* Pelo de atrás / forma de cabeza */}
          {skin === "cientifico" && (
            <path d="M28 46 L16 30 L31 33 L26 14 L41 25 L45 6 L56 21 L64 4 L70 21 L83 8 L83 25 L98 18 L91 34 L104 36 L90 45 Q80 30 60 30 Q40 30 30 48Z" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.2" />
          )}
          {skin === "licesita" && (
            // Pelo lacio de atrás: cae hasta los hombros
            <path d="M26 56 Q22 12 60 12 Q98 12 94 56 L97 104 Q86 109 78 101 L78 62 L42 62 L42 101 Q34 109 23 104 Z" fill="#1c1917" />
          )}
          {r?.peloAtras && <path d={r.peloAtras} fill="#1c1917" />}
          {r ? (
            <path d={r.cara} fill={piel} />
          ) : skin === "raton" ? (
            <>
              {/* Orejotas redondas, cabeza negra y antifaz de piel */}
              <circle cx="27" cy="20" r="17" fill="#111827" />
              <circle cx="93" cy="20" r="17" fill="#111827" />
              <circle cx="22" cy="15" r="4" fill="#374151" opacity="0.6" />
              <ellipse cx="60" cy="54" rx="31" ry="32" fill="#111827" />
              <ellipse cx="52" cy="50" rx="10" ry="15" fill={piel} />
              <ellipse cx="72" cy="50" rx="10" ry="15" fill={piel} />
              <ellipse cx="62" cy="70" rx="25" ry="17" fill={piel} />
            </>
          ) : skin === "travieso" ? (
            <>
              {/* Cabeza alta con la corona de picos y el hocico de barba */}
              <path d="M34 88 L34 28 L36 12 L43 22 L48 6 L55 20 L61 4 L67 20 L74 6 L79 22 L86 12 L87 30 L87 72 Q87 92 62 92 Q38 92 34 88 Z" fill={piel} />
              <path d="M44 72 Q44 92 64 92 Q84 92 84 74 Q78 68 64 68 Q50 68 44 72 Z" fill={piel} stroke="#a16207" strokeWidth="1" />
            </>
          ) : skin === "heroe" ? (
            <path d="M31 46 Q31 18 60 18 Q89 18 89 46 Q89 70 75 80 Q60 87 45 80 Q31 70 31 46Z" fill={piel} />
          ) : skin === "tomaso" ? (
            // Cara alargada y delgada
            <path d="M33 46 Q33 15 60 15 Q87 15 87 46 Q87 75 74 85 Q60 91 46 85 Q33 75 33 46Z" fill={piel} />
          ) : skin === "licesita" ? (
            // Óvalo suave, barbilla fina
            <path d="M32 50 Q32 18 60 18 Q88 18 88 50 Q88 74 74 84 Q60 90 46 84 Q32 74 32 50Z" fill={piel} />
          ) : skin === "ramon" ? (
            // Cara más ancha y mandíbula cuadrada
            <path d="M30 46 Q30 17 60 17 Q90 17 90 46 Q90 72 77 82 Q60 90 43 82 Q30 72 30 46Z" fill={piel} />
          ) : skin === "chibi" ? (
            <ellipse cx="60" cy="54" rx="32" ry="31" fill={piel} />
          ) : (
            <ellipse cx="60" cy="52" rx="31" ry="34" fill={piel} />
          )}
          {skin !== "raton" && (
            <>
              <ellipse cx="29.5" cy="57" rx="5" ry="7" fill={piel} />
              <path d="M27 56 Q29 53 31 57" fill="none" stroke={p.pielSolida} strokeWidth="1.2" />
            </>
          )}

          {/* Pelo */}
          {skin === "abuelo" && (
            <>
              <path d="M28 50 Q24 22 52 16 Q82 12 92 34 Q88 28 76 26 Q58 24 46 32 Q34 40 32 54Z" fill="#111827" />
              <path d="M33 50 Q31 40 36 33" stroke="#cbd5e1" strokeWidth="3.4" strokeLinecap="round" fill="none" />
              <path d="M44 20 Q60 14 80 22" stroke="#4b5563" strokeWidth="1.4" fill="none" strokeLinecap="round" />
            </>
          )}
          {skin === "heroe" && (
            <>
              <path d="M29 44 Q27 14 58 12 Q90 10 90 40 Q82 22 64 24 Q52 26 46 22 Q38 30 33 46Z" fill="#111827" />
              <path d="M60 12 Q68 1 77 9 Q70 7 66 14Z" fill="#111827" />
            </>
          )}
          {skin === "ramon" && (
            <>
              {/* Lados rebajados (fade) y arriba peinado hacia atrás */}
              <path d="M30 50 Q29 34 36 28 L38 48 Z M90 48 Q91 33 84 27 L83 46 Z" fill="#111827" opacity="0.4" />
              <path d="M32 42 Q29 14 60 10 Q91 12 88 40 Q85 26 73 24 Q60 21 47 25 Q37 29 34 42Z" fill="#111827" />
              <path d="M42 22 Q56 13 74 17 M46 27 Q60 19 78 23 M52 15 Q66 10 80 15" fill="none" stroke="#374151" strokeWidth="1.3" strokeLinecap="round" />
            </>
          )}
          {skin === "tomaso" && (
            <>
              {/* Pelo corto entrecano: entradas marcadas y sienes canosas */}
              <path d="M33 52 Q32 36 36 29 L38 50 Z M87 52 Q88 36 84 29 L82 50 Z" fill="#9ca3af" opacity="0.85" />
              <path d="M35 40 Q32 14 58 11 Q86 11 85 38 Q83 30 79 28 Q76 21 66 23 Q59 22 52 23 Q43 23 40 31 Q37 34 36.5 40Z" fill="#374151" />
              <path d="M44 19 Q56 13 72 16 M48 23 Q60 17 74 21 M41 27 Q44 22 49 21" fill="none" stroke="#9ca3af" strokeWidth="1.2" strokeLinecap="round" />
            </>
          )}
          {skin === "licesita" && (
            <>
              {/* Raya de lado, mechones que enmarcan la cara (tapan las orejas) */}
              <path d="M30 54 Q28 17 60 15 Q92 17 90 54 Q87 36 79 29 Q71 24 66 25 Q58 31 47 31 Q37 35 34 54Z" fill="#1c1917" />
              <path d="M30 50 Q27 78 33 101 L41 99 Q36 76 36.5 52Z M90 50 Q93 78 87 101 L79 99 Q84 76 83.5 52Z" fill="#1c1917" />
              <path d="M66 25 Q74 22 84 32 M40 34 Q48 28 58 29" fill="none" stroke="#44403c" strokeWidth="1.3" strokeLinecap="round" />
            </>
          )}
          {r?.pelo.map((t, i) => <path key={i} d={t.d} fill={t.fill} opacity={t.opacity} />)}
          {r?.mechas && <path d={r.mechas.d} fill="none" stroke={r.mechas.stroke} strokeWidth="1.3" strokeLinecap="round" />}
          {skin === "chibi" && (
            <path d="M27 58 Q24 22 58 20 Q94 18 94 54 Q86 36 72 36 Q70 28 60 33 Q44 30 34 42 Q28 50 29 60Z" fill="#111827" />
          )}

          {/* Goggles en la frente (en el científico van sobre los ojos, más abajo) */}
          {!gogglesEnOjos && !sinGoggles && (
            <>
              <rect x="30" y="30" width="60" height="7" rx="3.5" fill="url(#pj-laton)" transform="rotate(-5 60 33)" />
              <circle cx="52" cy="32.6" r="8.2" fill="url(#pj-laton)" />
              <circle cx="52" cy="32.6" r="5.6" fill="url(#pj-cristal)" />
              <circle cx="71" cy="31" r="8.2" fill="url(#pj-laton)" />
              <circle cx="71" cy="31" r="5.6" fill="url(#pj-cristal)" />
            </>
          )}

          {/* Ojos (abiertos, con párpado para "aburrido") */}
          <g className="pj-ojo-abierto pj-ojo-cartoon">
            {[52, 72].map((x) => (
              <g key={x}>
                <ellipse cx={x} cy="55" rx={ojo.rx} ry={ojo.ry} fill="#fff" stroke={skin === "travieso" ? "#1f2937" : undefined} strokeWidth="0.8" />
                <circle className="pj-pupila" cx={x + 1.8} cy="56" r={ojo.iris} fill={p.iris} />
                <circle cx={x + 2.3} cy="56.4" r={ojo.pupila} fill="#0f172a" />
                <circle cx={x + 3.4} cy="53.6" r={ojo.brillo} fill="#fff" />
                <path className="pj-parpado" d={`M${x - ojo.rx - 0.4} 55.4 A${ojo.rx + 0.4} ${ojo.ry + 0.4} 0 0 1 ${x + ojo.rx + 0.4} 55.4 Z`} fill={p.pielSolida} />
              </g>
            ))}
          </g>
          <path className="pj-ojo-cerrado" d="M46 56 Q52 61 58 56 M66 56 Q72 61 78 56" fill="none" stroke="#3f2a1d" strokeWidth="1.8" strokeLinecap="round" />
          {/* Cejas */}
          <path className="pj-ceja pj-ceja--seria" d="M45 45 Q52 42 59 45 M65 45 Q72 42 79 45" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />
          <path className="pj-ceja pj-ceja--feliz" d="M45 43 Q52 37 59 42 M65 42 Q72 37 79 43" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />
          <path className="pj-ceja pj-ceja--aburrida" d="M45 48 Q52 46.5 59 48.5 M65 48.5 Q72 46.5 79 48" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />
          <path className="pj-ceja pj-ceja--triste" d="M45 46 Q52 46 58 41.5 M66 41.5 Q72 46 79 46" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />

          {(skin === "licesita" || r?.pestanas) && (
            // Pestañas en la esquina de afuera
            <path className="pj-ojo-abierto" d="M45.6 50.6 L43 48.6 M46.6 49 L44.6 46.6 M78.4 50.6 L81 48.6 M77.4 49 L79.4 46.6" stroke="#1c1917" strokeWidth="1.3" strokeLinecap="round" />
          )}
          {skin === "tomaso" && (
            // Lentes al aire: cristal casi invisible, puente y patitas finas
            <g fill="none" stroke="#9ca3af" strokeWidth="1.3">
              <rect x="42" y="47.5" width="20" height="15" rx="6" fill="#e0f2fe" fillOpacity="0.18" />
              <rect x="63" y="47.5" width="20" height="15" rx="6" fill="#e0f2fe" fillOpacity="0.18" />
              <path d="M62 52 Q62.5 50.6 63 52 M42 51 L32 50 M83 51 L88 50" />
              <path d="M45 50 Q48 48.6 51 49.4" stroke="#fff" strokeWidth="1" opacity="0.7" />
            </g>
          )}

          {r?.lentes && (
            // Lentes de armazón
            <g fill="none" stroke={r.lentes.stroke} strokeWidth={r.lentes.ancho}>
              <rect x="42" y="47.5" width="20" height="15" rx="5" fill="#e0f2fe" fillOpacity="0.15" />
              <rect x="63" y="47.5" width="20" height="15" rx="5" fill="#e0f2fe" fillOpacity="0.15" />
              <path d="M62 52 Q62.5 50.6 63 52 M42 51 L32 50 M83 51 L88 50" />
            </g>
          )}

          {/* Goggles sobre los ojos (cristal translúcido: los ojos se ven) */}
          {gogglesEnOjos && (
            <>
              <rect x="30" y="47" width="60" height="15" rx="7.5" fill="url(#pj-laton)" opacity="0.95" />
              <circle cx="52" cy="55" r="10.4" fill="none" stroke="url(#pj-laton)" strokeWidth="3.4" />
              <circle cx="72" cy="55" r="10.4" fill="none" stroke="url(#pj-laton)" strokeWidth="3.4" />
              <circle cx="52" cy="55" r="8.6" fill="#bae6fd" opacity="0.28" />
              <circle cx="72" cy="55" r="8.6" fill="#bae6fd" opacity="0.28" />
              <path d="M47 50 Q50 48 53 49" stroke="#fff" strokeWidth="1.2" fill="none" opacity="0.8" />
            </>
          )}

          {/* Nariz */}
          {r?.nariz === "ancha" ? (
            <path d="M61 57 Q63 64 66 66 Q66 69.4 62 69.4 Q58 69.4 56.4 67.6" stroke={p.pielSolida} strokeWidth="2.2" fill="none" strokeLinecap="round" />
          ) : skin === "abuelo" || skin === "cientifico" || skin === "tomaso" || r?.nariz === "larga" ? (
            <path d="M62 57 Q66 68 72 70 Q68 74 61 72 Q58 70 60 66Z" fill={p.pielSolida} />
          ) : skin === "raton" ? (
            <>
              <ellipse cx="66" cy="66" rx="7" ry="5" fill="#111827" />
              <ellipse cx="64" cy="64.2" rx="2.2" ry="1.3" fill="#fff" opacity="0.7" />
            </>
          ) : skin === "travieso" ? (
            <path d="M63 60 Q78 57 79 64 Q78 70 63 68" fill={piel} stroke="#a16207" strokeWidth="1" />
          ) : skin === "ramon" ? (
            <path d="M61 56 Q64 64 66 67 Q63 70 58 68.5" stroke={p.pielSolida} strokeWidth="2" fill="none" strokeLinecap="round" />
          ) : skin === "heroe" ? (
            <path d="M61 57 Q64 65 62 67" stroke={p.pielSolida} strokeWidth="2" fill="none" strokeLinecap="round" />
          ) : (
            <path d="M60 66 Q63 70 66 67" stroke={p.pielSolida} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          )}
          {skin === "tomaso" && (
            // Arrugas: frente, patas de gallo, ojeras, surcos nasolabiales y mejillas hundidas
            <g fill="none" stroke={p.pielSolida} strokeLinecap="round" opacity="0.9">
              <path d="M48 36 Q60 33.5 72 36 M50 40.5 Q60 38.4 70 40.5" strokeWidth="1.1" />
              <path d="M38 53 L35 51.6 M38 56 L34.6 56 M38 59 L35 60.4 M86 53 L89 51.6 M86 56 L89.4 56 M86 59 L89 60.4" strokeWidth="0.9" />
              <path d="M46 63 Q52 65.6 58 63.4 M66 63.4 Q72 65.6 78 63" strokeWidth="1" />
              <path d="M56 66 Q51 72 53 79 M70 66 Q75 72 72 79" strokeWidth="1.3" />
              <path d="M40 66 Q42 74 46 78 M84 66 Q82 74 78 78" strokeWidth="1" opacity="0.6" />
            </g>
          )}
          {skin === "chibi" && (
            <>
              <ellipse cx="38" cy="70" rx="6" ry="3.6" fill="#fb7185" opacity="0.45" />
              <ellipse cx="85" cy="70" rx="6" ry="3.6" fill="#fb7185" opacity="0.45" />
            </>
          )}

          {/* Barba corta de candado que sigue la mandíbula (debajo de las bocas) */}
          {skin === "ramon" && (
            <>
              <path d="M32 56 Q32 76 44 83 Q60 91 76 83 Q88 76 88 56 L85 58 Q84 72 74 77 Q67 80 62 77 Q57 80 50 77 Q40 72 35 58 Z" fill="#1f2937" opacity="0.6" />
              <path d="M54 84 Q62 90 70 84 L68 80.5 Q62 83 56 80.5 Z" fill="#111827" opacity="0.75" />
            </>
          )}

          {r?.barba?.map((t, i) => t.fill === "none"
            ? <path key={i} d={t.d} fill="none" stroke="#d6d3d1" strokeWidth="1.2" strokeLinecap="round" opacity="0.8" />
            : <path key={i} d={t.d} fill={t.fill} opacity={t.opacity} />)}

          {/* Bocas (una por ánimo) */}
          <path className="pj-boca pj-boca--seria" d="M55 79.5 Q62 80.5 69 79.5" fill="none" stroke={labios} strokeWidth="2.2" strokeLinecap="round" />
          {skin === "ramon" ? (
            // Sonrisa amplia con dientes
            <g className="pj-boca pj-boca--feliz">
              <path d="M52.5 76 Q62 88 71.5 76 Q62 79 52.5 76 Z" fill="#3b0f0a" />
              <path d="M54.2 76.9 Q62 79.8 69.8 76.9 L69 79 Q62 81.6 55 79 Z" fill="#f8fafc" />
            </g>
          ) : (
            <path className="pj-boca pj-boca--feliz" d="M53 76.5 Q62 87 71 76.5" fill="none" stroke={labios} strokeWidth="2.2" strokeLinecap="round" />
          )}
          <g className="pj-boca pj-boca--grito">
            <path d="M53.5 75 Q62 94 70.5 75 Q62 78.5 53.5 75 Z" fill="#3b0f0a" />
            <path d="M56.5 84.5 Q62 89 67.5 84.5 Q62 82 56.5 84.5 Z" fill="#e05a5a" />
            <path d="M54.5 76 Q62 79 69.5 76" fill="none" stroke="#fff" strokeWidth="1.6" />
          </g>
          <path className="pj-boca pj-boca--aburrida" d="M55 80.5 Q58.5 77.5 62 80.5 Q65.5 83.5 69 79.5" fill="none" stroke={labios} strokeWidth="2.2" strokeLinecap="round" />
          <ellipse className="pj-boca pj-boca--dormida" cx="62" cy="80" rx="2.6" ry="2.1" fill="#3b0f0a" />
          <path className="pj-boca pj-boca--llora" d="M54 82.5 Q58 76.5 62 80.5 Q66 76.5 70 82.5" fill="none" stroke={labios} strokeWidth="2.2" strokeLinecap="round" />
          {/* Antojos: masticando, sorbiendo el popote, lamiendo */}
          <g className="pj-boca pj-boca--come"><ellipse className="pj-masca" cx="62" cy="80" rx="5.2" ry="3.4" fill="#3b0f0a" /></g>
          <circle className="pj-boca pj-boca--sorbe" cx="64" cy="80" r="2.8" fill="#7f1d1d" stroke="#c2706b" strokeWidth="1.8" />
          <g className="pj-boca pj-boca--lame">
            <path d="M55 76 Q62 88 69 76 Q62 79 55 76 Z" fill="#3b0f0a" />
            <path className="pj-lengua" d="M60 81 C60 89 68 90 69 82 Z" fill="#f472b6" />
          </g>

          {/* Bigote del abuelo (encima de la boca) */}
          {skin === "abuelo" && (
            <path d="M49 74 Q55 70 62 73.5 Q69 70 75 74 Q70 78.5 62 76 Q54 78.5 49 74 Z" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="0.7" />
          )}
          {skin === "ramon" && (
            <path d="M50 74 Q56 70.5 62 72.5 Q68 70.5 74 74 Q69 75.6 62 74.6 Q55 75.6 50 74 Z" fill="#111827" opacity="0.85" />
          )}
          {r?.bigote && <path d={r.bigote.d} fill={r.bigote.fill} opacity={r.bigote.opacity} />}
          {skin === "heroe" && <path d="M56 86 Q60 88 64 86" stroke={p.pielSolida} strokeWidth="1.4" fill="none" />}

          {/* Lágrimas */}
          <g className="pj-lagrimas">
            <path className="pj-lagrima" d="M50 62 C47.6 66 47.6 69 50 69.6 C52.4 69 52.4 66 50 62 Z" fill="#7dd3fc" />
            <path className="pj-lagrima pj-lagrima--2" d="M74 62 C71.6 66 71.6 69 74 69.6 C76.4 69 76.4 66 74 62 Z" fill="#bae6fd" />
          </g>
        </g>
      </g>
    </g>
  );
}

/** Bata de laboratorio sobre el torso (científico). */
export function Bata() {
  return (
    <>
      <path d="M36.4 37.2 C37.4 34.6 42 33.2 48 33.2 C54 33.2 58.6 34.6 59.6 37.2 C61.2 46 61.6 56 62.6 68 L54 68 L51 46 L45 46 L42 68 L33.4 68 C34.4 56 34.8 46 36.4 37.2 Z" fill="url(#pj-bata)" />
      <path d="M44 34 L48 46 L52 34" fill="none" stroke="#cbd5e1" strokeWidth="0.8" />
      <rect x="52.8" y="42" width="4.2" height="4.6" rx="0.6" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.4" />
      <path d="M54 41 L54 43.6 M55.8 41 L55.8 43.6" stroke="#3b82f6" strokeWidth="0.6" />
    </>
  );
}

/** Saco abierto sobre el torso: camisa en V, solapas y botón (Ramón, Tomaso). */
export function Saco({ camisa = "#d1d5db", cuello = "#e5e7eb", solapa = "#111827", boton = "#0b0f19", corbata }: {
  camisa?: string;
  cuello?: string;
  solapa?: string;
  boton?: string;
  corbata?: string;
}) {
  return (
    <>
      {/* Camisa y cuello */}
      <path d="M43.4 34 L48 52 L52.6 34 Q48 32.8 43.4 34 Z" fill={camisa} />
      <path d="M48 36 L48 52" stroke="#9ca3af" strokeWidth="0.4" />
      <circle cx="48" cy="43" r="0.5" fill="#9ca3af" />
      {corbata && (
        <>
          <path d="M46.9 35.6 L49.1 35.6 L49.6 37.6 L48 38.6 L46.4 37.6 Z M46.7 38.4 L49.3 38.4 L50.1 50.6 L48 52.6 L45.9 50.6 Z" fill={corbata} />
          <path d="M46.6 41 L49.6 39.6 M46.4 44 L49.8 42.6 M46.2 47 L50 45.6" stroke="#ffffff" strokeWidth="0.25" opacity="0.35" />
        </>
      )}
      <path d="M43.4 34 L46.8 39.4 L48 35.4 Z M52.6 34 L49.2 39.4 L48 35.4 Z" fill={cuello} stroke="#9ca3af" strokeWidth="0.3" />
      {/* Solapas */}
      <path d="M42.6 34.6 L47.6 52.4 L44.6 46 L40.2 42.4 L42 39.4 L40.4 37.8 Z" fill={solapa} />
      <path d="M53.4 34.6 L48.4 52.4 L51.4 46 L55.8 42.4 L54 39.4 L55.6 37.8 Z" fill={solapa} />
      <circle cx="48" cy="55.6" r="0.9" fill={boton} stroke="#4b5563" strokeWidth="0.3" />
    </>
  );
}

/** Vestido sin mangas: escote de corazón con la piel arriba, collar y faja (Licesita). */
export function Vestido({ skin }: { skin: Skin }) {
  return (
    <>
      <path d="M36.2 37.4 C37.2 34.6 42 33.2 48 33.2 C54 33.2 58.8 34.6 59.8 37.4 L59.7 40.2 Q55.6 38.4 51.4 40.4 L48 43.2 L44.6 40.4 Q40.4 38.4 36.3 40.2 Z" fill={`url(#pj-piel-${skin})`} />
      <path d="M36.3 40.2 Q40.4 38.4 44.6 40.4 L48 43.2 L51.4 40.4 Q55.6 38.4 59.7 40.2" fill="none" stroke="#0b4a55" strokeWidth="0.6" />
      {/* Collar con dije */}
      <path d="M44 34.2 Q48 39.4 52 34.2" fill="none" stroke="#e5e7eb" strokeWidth="0.35" />
      <circle cx="48" cy="37.2" r="0.6" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.2" />
      {/* Pliegue cruzado del frente */}
      <path d="M51 44 Q46 50 40.6 53" fill="none" stroke="#0b4a55" strokeWidth="0.5" opacity="0.7" />
    </>
  );
}

/** Camisa blanca con el cuello abierto y botones (Abel). */
export function Camisa({ skin }: { skin: Skin }) {
  return (
    <>
      <path d="M45 33.8 L48 39.6 L51 33.8 Z" fill={`url(#pj-piel-${skin})`} />
      <path d="M43.2 33.6 L46.6 39 L48 35.2 Z M52.8 33.6 L49.4 39 L48 35.2 Z" fill="#ffffff" stroke="#cbd5e1" strokeWidth="0.35" />
      <path d="M48 39.6 L48 60" stroke="#cbd5e1" strokeWidth="0.4" />
      {[43, 47.5, 52, 56.5].map((y) => <circle key={y} cx="48.7" cy={y} r="0.45" fill="#cbd5e1" />)}
    </>
  );
}

/** Blusa blanca cruzada con lunares negros (Keity). */
export function Blusa({ skin }: { skin: Skin }) {
  const lunares = [[39.6, 40], [44, 46.4], [52.4, 45], [56.4, 39.4], [39.8, 51.4], [46.8, 52.6], [54.6, 51], [42.4, 57.2], [50.2, 57.8], [56, 56.6], [44.6, 36.4]];
  return (
    <>
      <path d="M43.6 34 L48 42 L52.4 34 Q48 32.8 43.6 34 Z" fill={`url(#pj-piel-${skin})`} />
      <path d="M52.4 34 L48 42 L42 54" fill="none" stroke="#d1d5db" strokeWidth="0.5" />
      {lunares.map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="0.95" fill="#111827" />)}
    </>
  );
}
