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
  );
}

/** Brazo del frente de carne y hueso (mismas articulaciones que el robótico: hombro 58,39 · codo 58.1,51.6). */
export function BrazoHumano({ skin }: { skin: Skin }) {
  const manga = skin === "cientifico" ? "url(#pj-bata)" : `url(#pj-camisa-${skin})`;
  return (
    <g className="pj-brazo-robot">
      <path d="M55.2 38.6 C54.6 42.6 54.8 46.6 55.3 51 L60.9 51 C61.4 46.6 61.6 42.6 61 38.6 C59 36.8 57 36.8 55.2 38.6 Z" fill={manga} />
      <g className="pj-antebrazo">
        <circle cx="58.1" cy="51.4" r="2.9" fill={manga} />
        <path d="M55.4 51.2 C55.1 54.4 55.2 57.6 55.6 60.6 L60.6 60.6 C61 57.6 61.1 54.4 60.8 51.2 Z" fill={manga} />
        <path d="M55.4 58.6 C57.2 59.6 59.2 59.6 60.8 58.6 L60.6 61.2 C59 62 57.2 62 55.6 61.2 Z" fill="#6b727c" />
        {/* Mano */}
        <path d="M55.2 61.2 C54.6 64.4 55.6 67.4 58.2 67.6 C60.8 67.8 61.8 65 61.2 61.2 Z" fill={`url(#pj-piel-${skin})`} />
        <path d="M55.4 62.4 C54.2 63 54 64.6 55 65.4" fill="none" stroke={PALETA[skin].pielSolida} strokeWidth="1.3" strokeLinecap="round" />
        <Antojos />
      </g>
    </g>
  );
}

/**
 * Cabeza cartoon (de frente, ¾ hacia la derecha) dibujada en el espacio de los
 * bocetos (centro 60,52) y reducida al cuello del esqueleto. Los elementos de
 * expresión usan las mismas clases que la cyborg (pj-ojo-abierto, pj-ceja--*,
 * pj-boca--*, pj-lagrimas…), así que personaje.css los prende y apaga igual.
 */
export function CabezaCartoon({ skin }: { skin: Exclude<Skin, "cyborg"> }) {
  const p = PALETA[skin];
  const piel = `url(#pj-piel-${skin})`;
  // Chibi: la cabeza crece sobre el cuello.
  const escala = skin === "chibi" ? "translate(49 31) scale(1.42) translate(-49 -31)" : undefined;
  const gogglesEnOjos = skin === "cientifico";
  return (
    <g className="pj-cabeza">
      {/* Cuello */}
      <path d="M45.6 28.6 C45.6 31.6 45.2 33.8 44.8 35.8 L51.4 35.8 C51 33.8 50.6 31.6 50.6 28.6 Z" fill={piel} />
      <g transform={escala}>
        <g transform="translate(49 17.5) scale(0.345) translate(-60 -52)">
          {/* Pelo de atrás / forma de cabeza */}
          {skin === "cientifico" && (
            <path d="M28 46 L16 30 L31 33 L26 14 L41 25 L45 6 L56 21 L64 4 L70 21 L83 8 L83 25 L98 18 L91 34 L104 36 L90 45 Q80 30 60 30 Q40 30 30 48Z" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.2" />
          )}
          {skin === "heroe" ? (
            <path d="M31 46 Q31 18 60 18 Q89 18 89 46 Q89 70 75 80 Q60 87 45 80 Q31 70 31 46Z" fill={piel} />
          ) : skin === "chibi" ? (
            <ellipse cx="60" cy="54" rx="32" ry="31" fill={piel} />
          ) : (
            <ellipse cx="60" cy="52" rx="31" ry="34" fill={piel} />
          )}
          <ellipse cx="29.5" cy="57" rx="5" ry="7" fill={piel} />
          <path d="M27 56 Q29 53 31 57" fill="none" stroke={p.pielSolida} strokeWidth="1.2" />

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
          {skin === "chibi" && (
            <path d="M27 58 Q24 22 58 20 Q94 18 94 54 Q86 36 72 36 Q70 28 60 33 Q44 30 34 42 Q28 50 29 60Z" fill="#111827" />
          )}

          {/* Goggles en la frente (en el científico van sobre los ojos, más abajo) */}
          {!gogglesEnOjos && (
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
                <ellipse cx={x} cy="55" rx={skin === "chibi" ? 7.4 : 6} ry={skin === "chibi" ? 8.6 : 7} fill="#fff" />
                <circle className="pj-pupila" cx={x + 1.8} cy="56" r={skin === "chibi" ? 5 : 3.7} fill={p.iris} />
                <circle cx={x + 2.3} cy="56.4" r={skin === "chibi" ? 2.4 : 1.8} fill="#0f172a" />
                <circle cx={x + 3.4} cy="53.6" r={skin === "chibi" ? 1.7 : 1.1} fill="#fff" />
                <path className="pj-parpado" d={`M${x - 6.4} 55.4 A6.4 7.4 0 0 1 ${x + 6.4} 55.4 Z`} fill={p.pielSolida} />
              </g>
            ))}
          </g>
          <path className="pj-ojo-cerrado" d="M46 56 Q52 61 58 56 M66 56 Q72 61 78 56" fill="none" stroke="#3f2a1d" strokeWidth="1.8" strokeLinecap="round" />
          {/* Cejas */}
          <path className="pj-ceja pj-ceja--seria" d="M45 45 Q52 42 59 45 M65 45 Q72 42 79 45" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />
          <path className="pj-ceja pj-ceja--feliz" d="M45 43 Q52 37 59 42 M65 42 Q72 37 79 43" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />
          <path className="pj-ceja pj-ceja--aburrida" d="M45 48 Q52 46.5 59 48.5 M65 48.5 Q72 46.5 79 48" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />
          <path className="pj-ceja pj-ceja--triste" d="M45 46 Q52 46 58 41.5 M66 41.5 Q72 46 79 46" fill="none" stroke={p.ceja} strokeWidth="3.2" strokeLinecap="round" />

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
          {skin === "abuelo" || skin === "cientifico" ? (
            <path d="M62 57 Q66 68 72 70 Q68 74 61 72 Q58 70 60 66Z" fill={p.pielSolida} />
          ) : skin === "heroe" ? (
            <path d="M61 57 Q64 65 62 67" stroke={p.pielSolida} strokeWidth="2" fill="none" strokeLinecap="round" />
          ) : (
            <path d="M60 66 Q63 70 66 67" stroke={p.pielSolida} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          )}
          {skin === "chibi" && (
            <>
              <ellipse cx="38" cy="70" rx="6" ry="3.6" fill="#fb7185" opacity="0.45" />
              <ellipse cx="85" cy="70" rx="6" ry="3.6" fill="#fb7185" opacity="0.45" />
            </>
          )}

          {/* Bocas (una por ánimo) */}
          <path className="pj-boca pj-boca--seria" d="M55 79.5 Q62 80.5 69 79.5" fill="none" stroke="#7c3a1d" strokeWidth="2.2" strokeLinecap="round" />
          <path className="pj-boca pj-boca--feliz" d="M53 76.5 Q62 87 71 76.5" fill="none" stroke="#7c3a1d" strokeWidth="2.2" strokeLinecap="round" />
          <g className="pj-boca pj-boca--grito">
            <path d="M53.5 75 Q62 94 70.5 75 Q62 78.5 53.5 75 Z" fill="#3b0f0a" />
            <path d="M56.5 84.5 Q62 89 67.5 84.5 Q62 82 56.5 84.5 Z" fill="#e05a5a" />
            <path d="M54.5 76 Q62 79 69.5 76" fill="none" stroke="#fff" strokeWidth="1.6" />
          </g>
          <path className="pj-boca pj-boca--aburrida" d="M55 80.5 Q58.5 77.5 62 80.5 Q65.5 83.5 69 79.5" fill="none" stroke="#7c3a1d" strokeWidth="2.2" strokeLinecap="round" />
          <ellipse className="pj-boca pj-boca--dormida" cx="62" cy="80" rx="2.6" ry="2.1" fill="#3b0f0a" />
          <path className="pj-boca pj-boca--llora" d="M54 82.5 Q58 76.5 62 80.5 Q66 76.5 70 82.5" fill="none" stroke="#7c3a1d" strokeWidth="2.2" strokeLinecap="round" />

          {/* Bigote del abuelo (encima de la boca) */}
          {skin === "abuelo" && (
            <path d="M49 74 Q55 70 62 73.5 Q69 70 75 74 Q70 78.5 62 76 Q54 78.5 49 74 Z" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="0.7" />
          )}
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
