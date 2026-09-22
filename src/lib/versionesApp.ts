import { playPublishedVersion, playEnCamino, type PlayTracksDoc } from "./playTracks";
import { appStoreLiveVersion, appStoreEnCamino, type AppStoreStatusDoc } from "./appStoreStatus";

// ---------------------------------------------------------------------------
// ¿La web va por delante de lo que hay en las tiendas?
//
// En una app, el front se publica el mismo día que se mergea y las tiendas van
// por detrás hasta que alguien lanza un build y lo sube. Ese hueco —web en
// 1.2.5, tienda en 1.2.2— es el momento de construir, y no se veía: había que
// comparar tres chips a ojo, en tarjetas distintas, y acordarse de hacerlo.
// ---------------------------------------------------------------------------

/**
 * Los números de una versión, sin lo que venga detrás.
 *
 * La web publica cosas como `1.2.5-260922.1347` —la marca de build que añade el
 * pipeline— y las tiendas publican `1.2.5` a secas. Comparadas como texto,
 * nunca coinciden.
 */
export function nucleoDeVersion(v?: string | null): number[] | null {
  const m = v?.match(/\d+(?:\.\d+)*/);
  if (!m) return null;
  const n = m[0].split(".").map(Number).slice(0, 3);
  return n.some(Number.isNaN) ? null : n;
}

/** 1 si `a` es posterior, -1 si anterior, 0 si la misma. `null` si no se sabe. */
export function comparaVersiones(a?: string | null, b?: string | null): number | null {
  const x = nucleoDeVersion(a);
  const y = nucleoDeVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface RezagoDeTienda {
  /** Lo que la gente puede bajar hoy. */
  publicada: string | null;
  /** Lo enviado y esperando revisión, si hay algo. */
  enCamino: string | null;
  /** La web va por delante de lo publicado. */
  atras: boolean;
  /**
   * Y además no hay nada enviado que lo cubra.
   *
   * Es la diferencia entre "hay que construir" y "ya se construyó y la tienda
   * está tardando": lo segundo no pide nada de nadie.
   */
  pendiente: boolean;
}

export interface RezagoTiendas {
  versionWeb: string | null;
  android: RezagoDeTienda | null;
  ios: RezagoDeTienda | null;
  /** Alguna tienda pide un build. */
  hayQueConstruir: boolean;
}

function rezago(
  versionWeb: string | null,
  publicada: string | null,
  enCamino: string | null,
): RezagoDeTienda {
  const atras = comparaVersiones(versionWeb, publicada) === 1;
  const cubierta = (comparaVersiones(enCamino, versionWeb) ?? -1) >= 0;
  return { publicada, enCamino, atras, pendiente: atras && !cubierta };
}

export function rezagoDeTiendas(
  versionWeb: string | null,
  play: PlayTracksDoc | null | undefined,
  appStore: AppStoreStatusDoc | null | undefined,
  { conAndroid, conIos }: { conAndroid: boolean; conIos: boolean },
): RezagoTiendas {
  const pub = playPublishedVersion(play);
  const android = conAndroid
    // Solo cuenta lo que está en producción: una versión en pruebas internas no
    // es lo que tiene instalado nadie, y compararse contra ella diría que no
    // hace falta construir cuando sí hace falta.
    ? rezago(versionWeb, pub?.esProduccion ? pub.version : null, playEnCamino(play))
    : null;

  const live = appStoreLiveVersion(appStore);
  const ios = conIos
    ? rezago(
        versionWeb,
        live?.aLaVenta ? live.version : null,
        (live?.aLaVenta ? appStoreEnCamino(appStore)?.version : live?.version) ?? null,
      )
    : null;

  return {
    versionWeb,
    android,
    ios,
    hayQueConstruir: !!android?.pendiente || !!ios?.pendiente,
  };
}
