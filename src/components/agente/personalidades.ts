/**
 * Sentido del humor de cada avatar: sus chistes (cada uno es un diálogo corto,
 * línea por línea), lo que dice caminando y aburrido, y la animación con la que
 * los cuenta. En los avatares de dos, las líneas alternan entre los dos
 * (`Slobo:` / `Ricardo:`…). Lo que no traiga un avatar, sale de las frases
 * generales de GeorgIA.
 */
import type { Skin } from "./skinsDatos";

/** Animación con la que cuenta el chiste (poses de personaje.css). */
export type PoseChiste = "explicar" | "risa" | "sigilo" | "rugido" | "hadouken" | "comer" | "brinco" | "porra" | "pensar" | "jalarpelo" | "victoria" | "abanicar";

export type Personalidad = {
  pose: PoseChiste;
  /** Cada chiste: sus líneas en orden. */
  chistes: string[][];
  caminar?: string[];
  aburrido?: string[];
};

export const PERSONALIDAD: Partial<Record<Skin, Personalidad>> = {
  // ── La Cotorrisa: se avientan la bolita y se carcajean de todo ──
  cotorrisa: {
    pose: "risa",
    chistes: [
      ["Slobo: Oye Ricardo, ¿sabías que hice un deploy el viernes?", "Ricardo: ¿Y qué pasó?", "Slobo: Nada, por eso hoy es lunes y sigo aquí. JAJAJA"],
      ["Ricardo: ¿Cuál es el colmo de un programador?", "Slobo: ¿Cuál?", "Ricardo: Que su novia le pida espacio… y le dé un TAB. JAJAJAJA"],
      ["Slobo: Wey, el QA me regresó el ticket.", "Ricardo: ¿Por qué?", "Slobo: Porque sí funcionaba. Se sacó de onda. JAJAJA"],
      ["Ricardo: Bienvenidos a La Cotorrisa, el único podcast con más bugs que audiencia.", "Slobo: ¡Y aun así nos patrocina el CI! JAJAJA"],
      ["Slobo: Me dijeron que mi código era limpio.", "Ricardo: ¿Neta?", "Slobo: Sí, no tenía nada adentro. JAJAJAJA"],
      ["Ricardo: ¿Por qué el servidor se fue a terapia?", "Slobo: ¿Por qué?", "Ricardo: Tenía demasiadas peticiones sin resolver. JAJAJA, ¡no mames!"],
      ["Slobo: Ricardo, ¿qué es un merge sin conflictos?", "Ricardo: Una leyenda urbana, como el Chupacabras. JAJAJA"],
      ["Ricardo: Oye, ¿y tus tests?", "Slobo: Los dejo en producción, que los pruebe el cliente. JAJAJAJA", "Ricardo: ¡Eso no se dice al aire, wey!"],
    ],
    caminar: ["¡Qué cotorreo, banda!", "Slobo: ¿Ya le dieron like al PR?", "Ricardo: Esto parece episodio piloto, wey", "JAJAJA, ¡ya, ya!", "Slobo: Aguanta, aguanta, se me ocurrió otro…"],
    aburrido: ["Ricardo: ¿Grabamos o qué?", "Slobo: Se cayó el stream… ah no, nadie está viendo", "Ricardo: Cuéntate uno, Slobo", "Slobo: Patrocinado por el café de la oficina"],
  },
  // ── Cantinflas: habla mucho y no dice nada, ahí está el detalle ──
  cantinflas: {
    pose: "explicar",
    chistes: [
      ["Mire, joven, el bug no es que esté…", "…sino que, pues, digamos, ahí está…", "¡Ahí está el detalle!"],
      ["¿El deploy? Ni lo uno ni lo otro…", "…sino todo lo contrario. ¿Me explico o me explayo?"],
      ["Yo no digo que el código esté mal, chato…", "…nomás que funciona de una manera muy suya, muy particular, muy… ¿cómo le diré?"],
      ["¿Que si ya terminé el ticket? Pues mire…", "…terminar, terminar, lo que se dice terminar…", "…no. Pero ya lo empecé a pensar, que es lo más difícil."],
      ["Aquí entre nos, el que hizo ese merge…", "…no fui yo. Fue mi otro yo, el que sí trabaja."],
      ["Un programador sin café es como un sin qué ni para qué, ¿verdad?", "Bueno, no sé qué quise decir, pero lo dije bonito."],
    ],
    caminar: ["Ahí está el detalle", "Ni lo uno ni lo otro, sino todo lo contrario", "¿Me explico o me explayo?", "Estamos peor, pero estamos mejor", "Hay momentos en la vida que son verdaderamente momentáneos"],
    aburrido: ["Mire, el que nada hace, nada teme… y yo no temo nada", "Pues ya ni modo, chato", "El trabajo es sagrado… por eso no lo toco"],
  },
  // ── Pantera Rosa: no habla, tararea su tema y se escabulle ──
  pantera: {
    pose: "sigilo",
    chistes: [
      ["🎵 Tan-tan… tan-tan…", "(se lleva el bug de puntitas)", "🎵 …tan-tan-tan-taaaaan"],
      ["…", "(pinta todo el dashboard de rosa)", "🎵 Tara-raaa…"],
      ["(deja un letrero: «Cerrado por pantera»)", "🎵 Tan-tan…"],
      ["(el inspector busca el bug)", "(la pantera ya lo resolvió y se fue)", "🩷"],
      ["(saca un pincel rosa)", "(pinta el botón de «Merge a main»)", "…ahora sí combina"],
    ],
    caminar: ["🎵 Tan-tan…", "🎵 Tan-tan… tan-tan…", "(camina de puntitas)", "…", "🩷"],
    aburrido: ["(bosteza en rosa)", "🎵 …taaan…", "(se lima las uñas)"],
  },
  // ── Dinosaurio: rugidos, bracitos cortos y la extinción ──
  dino: {
    pose: "rugido",
    chistes: [
      ["¡RAWR!", "…perdón, así digo «buenos días»."],
      ["¿Por qué no uso el teclado?", "Mírame los bracitos. Mejor dicto los commits."],
      ["Yo sobreviví a un meteorito…", "…pero no a un merge conflict en viernes."],
      ["Mi código es tan viejo como yo:", "jurásico, pero todavía jala."],
      ["¿Saben por qué nos extinguimos?", "No hicimos backup. Aprendan."],
      ["¡RAAAWR!", "…ah, no, nomás se me cayó el café y no lo alcanzo."],
    ],
    caminar: ["¡RAWR!", "Pisadas de deploy: BUM, BUM", "Estos bracitos no alcanzan el mouse", "Soy legacy, pero sigo en producción", "Que no me vean los paleontólogos"],
    aburrido: ["¡Raawr…! (bostezo)", "Hace 65 millones de años que nadie me pregunta nada", "Me estoy fosilizando"],
  },
  // ── Homero: donas, D'oh y cero ganas de trabajar ──
  homero: {
    pose: "comer",
    chistes: [
      ["Mmm… donas…", "¿Qué? Están en el ticket. Bueno, no, pero deberían."],
      ["¡D'OH!", "Hice merge a main sin querer.", "…bueno, queriendo, pero sin pensar."],
      ["El trabajo es el problema y la solución…", "…de todos mis problemas. Y la siesta también."],
      ["Intentar es el primer paso hacia el fracaso.", "Por eso yo ni abro el ticket."],
      ["¿Por qué tengo que testear?", "¡Si ya lo vi con los ojitos!", "D'oh…"],
      ["Mmm… pizza sin reviews…", "…¡aaaghh! (babea)"],
    ],
    caminar: ["Mmm… donas", "¡D'oh!", "¡Woo-hoo!", "¿Dónde dejé mi Duff?", "Que trabaje Lenny"],
    aburrido: ["Zzz… mmm… donas…", "¿Ya es hora de ir con Moe?", "Si nadie me ve, no cuenta como flojera"],
  },
  // ── Lilo & Stitch: Ohana y caos azul ──
  stitch: {
    pose: "brinco",
    chistes: [
      ["Lilo: Ohana significa familia.", "Stitch: Y familia significa…", "Lilo: …que nadie hace merge sin review."],
      ["Stitch: ¡Meega, nala kweesta!", "Lilo: ¡Stitch! No le digas eso al CI."],
      ["Lilo: Stitch, ¿rompiste producción?", "Stitch: …no.", "Lilo: Stitch.", "Stitch: …poquito."],
      ["Stitch: ¡Ih! ¡Bug!", "(se lo come)", "Lilo: Así no se arreglan, Stitch."],
      ["Lilo: Este es Stitch, mi perro.", "Stitch: ¡Programador!", "Lilo: …mi perro programador."],
    ],
    caminar: ["Stitch: ¡Ih!", "Lilo: Ohana", "Stitch: ¡Aloha!", "Lilo: Nadie se queda atrás… ni el PR", "Stitch: ¡Ploop!"],
    aburrido: ["Stitch: ¿Cuándo destruimos algo?", "Lilo: Pon a Elvis", "Stitch: Aburrido… aburriiiido"],
  },
  // ── Ratatouille: Remy cocina, Linguini obedece (jalándole el pelo) ──
  linguini: {
    pose: "jalarpelo",
    chistes: [
      ["Remy: Cualquiera puede cocinar…", "Linguini: …pero no cualquiera hace deploy sin romper nada."],
      ["Linguini: ¡Au! ¡Remy, el pelo!", "Remy: Era para que hicieras rollback, no rebase."],
      ["Remy: Este código necesita sazón.", "Linguini: ¿Más comentarios?", "Remy: Menos console.log."],
      ["Linguini: ¿Qué es la ratatouille?", "Remy: Un plato sencillo… como un buen PR: pocos ingredientes, bien hechos."],
      ["Remy: No es un bug, es una salsa experimental.", "Linguini: El crítico no opina igual…"],
    ],
    caminar: ["Remy: Huele a refactor", "Linguini: ¡Au! ¡Ya voy, ya voy!", "Remy: Pruébalo antes de servir", "Linguini: Sí, chef"],
    aburrido: ["Remy: La cocina está muy callada", "Linguini: ¿Hacemos una sopa de bugs?", "Remy: Nadie pide nada… triste"],
  },
  // ── Ryu y Ken: rivalidad, gritos de pelea y combos ──
  ryu: {
    pose: "hadouken",
    chistes: [
      ["Ryu: ¡HADOUKEN!", "Ken: ¿A quién le tiraste?", "Ryu: Al bug del login."],
      ["Ken: ¡SHORYUKEN!", "Ryu: Ken, eso fue un merge a main.", "Ken: …perfect."],
      ["Ryu: La verdadera pelea es contra uno mismo.", "Ken: Y contra el linter."],
      ["Ken: Round 1… FIGHT!", "Ryu: ¿Contra quién?", "Ken: Contra los tickets de alta prioridad."],
      ["Ryu: Entreno todos los días.", "Ken: Yo también: rebase, rebase, rebase."],
      ["Ken: ¡Tatsumaki senpukyaku!", "Ryu: Eso no arregla el CSS, Ken."],
    ],
    caminar: ["Ryu: El camino del guerrero…", "Ken: ¡Vamos, Ryu!", "Ryu: Un buen commit es como un buen golpe", "Ken: K.O.", "Ryu: ¡Hadouken!"],
    aburrido: ["Ken: ¿Y si peleamos?", "Ryu: Medito…", "Ken: Insert coin"],
  },

  // ── Los de siempre, cada uno con lo suyo ──
  abuelo: {
    pose: "explicar",
    chistes: [
      ["En mis tiempos no había Git…", "…guardábamos las versiones en disquetes. ¡Y en 3½!"],
      ["Mijo, ¿sabes qué es un bug?", "Antes era una polilla en la computadora. Ahora es tu código."],
      ["Yo inventé el deploy los viernes.", "…y desde entonces no descanso los sábados."],
    ],
    caminar: ["En mis tiempos esto se hacía en COBOL", "Ay, mis rodillas…", "¿Dónde dejé mis lentes?"],
  },
  heroe: {
    pose: "victoria",
    chistes: [
      ["¡No temas, ciudadano!", "¡Yo revisaré tu PR!", "…¿dónde está el botón de aprobar?"],
      ["Mi superpoder es leer logs…", "…mi debilidad es el CSS."],
      ["Un gran poder conlleva…", "…una gran cantidad de permisos en el repo."],
    ],
    caminar: ["¡La justicia no descansa!", "Ningún bug quedará impune", "¡Vigilando producción!"],
  },
  chibi: {
    pose: "porra",
    chistes: [
      ["¡Kawaii! Un deploy exitoso ✨", "…ah, no, falló. ¡Kawaii igual!"],
      ["¿Cómo se llama un bug tierno?", "¡Un bugcito! UwU"],
      ["¡Ganbatte, código!", "¡Tú puedes compilar!"],
    ],
    caminar: ["✨ UwU ✨", "¡Nyan!", "¡Ganbatte!", "Kawaii desu"],
  },
  cientifico: {
    pose: "pensar",
    chistes: [
      ["¡Funciona! ¡FUNCIONA!", "…no sé por qué, pero no lo toquen."],
      ["Mi hipótesis: el bug está en producción.", "Mi experimento: hacer deploy.", "Mi conclusión: tenía razón."],
      ["¿Por qué mezclé dos frameworks?", "¡Por la CIENCIA!"],
    ],
    caminar: ["¡Eureka!", "Hipótesis… comprobada… creo", "Mwahaha, otro experimento"],
  },
  raton: {
    pose: "brinco",
    chistes: [
      ["¡Ja-já! ¡Hola, amiguitos!", "Hoy vamos a contar bugs: uno, dos… ¡muchos!"],
      ["¿Quién vive en un repo bajo el mar?", "…no, ese es otro. Yo vivo en dev. ¡Ja-já!"],
      ["¡Oh, cielos!", "Se me olvidó el punto y coma."],
    ],
    caminar: ["¡Ja-já!", "¡Oh, cielos!", "¡Qué divertido!"],
  },
  travieso: {
    pose: "victoria",
    chistes: [
      ["¡Ay, caramba!", "Alguien cambió todos los tabs por espacios…", "…no fui yo. Nadie me vio. No pueden probar nada."],
      ["¿Saben qué es mejor que un bug?", "Un bug en el código de otro. ¡Ja!"],
      ["Escribiré 100 veces: «no haré push a main».", "…git push --force. Ups."],
    ],
    caminar: ["¡Ay, caramba!", "¡Multiplícate por cero!", "Yo no fui", "No tengas un cow, man"],
  },
  cyborg: {
    pose: "explicar",
    chistes: [
      ["Bip, bup.", "Procesando chiste…", "Error 404: gracia no encontrada."],
      ["Mi mitad humana quiere café.", "Mi mitad robot quiere actualizarse.", "Las dos quieren vacaciones."],
      ["Calculé 14 millones de futuros…", "…en todos hay un hotfix el viernes."],
    ],
    caminar: ["Bip.", "Recalculando ruta…", "Batería al 12%… pero sigo", "Escaneando bugs…"],
  },
  // El equipo: humor de oficina, ligero.
  ramon: {
    pose: "explicar",
    chistes: [
      ["¿Saben por qué el desarrollador fue al doctor?", "Tenía demasiados problemas de dependencia."],
      ["Les tengo una buena y una mala.", "La buena: el deploy salió.", "La mala: era el de ayer."],
    ],
  },
  tomaso: {
    pose: "pensar",
    chistes: [
      ["Con todo respeto…", "…este PR necesita otro café antes de aprobarse."],
      ["Elegancia es borrar código…", "…y que todo siga funcionando."],
    ],
  },
  licesita: {
    pose: "porra",
    chistes: [
      ["¡Hoy es un gran día para cerrar tickets!", "…o por lo menos para abrirlos bonito."],
      ["¿Saben qué combina con todo?", "Un PR aprobado ✨"],
    ],
  },
  keity: {
    pose: "explicar",
    chistes: [
      ["Ah, ¿que «ya quedó»?", "Ajá. Como el de la semana pasada."],
      ["Mi parte favorita del día:", "cuando el bug era un typo."],
    ],
  },
  abel: {
    pose: "victoria",
    chistes: [
      ["¿Saben cuál es el deporte favorito del programador?", "El salto… de ticket en ticket."],
      ["Equipo que hace review junto…", "…hace deploy tranquilo."],
    ],
  },
  pablo: {
    pose: "pensar",
    chistes: [
      ["Un buen código es como un buen vino…", "…mejora con los años. El mío ya es vinagre."],
      ["Primero lo hago funcionar…", "…luego lo hago bonito… luego lo dejo así."],
    ],
  },
  rodrigo: {
    pose: "explicar",
    chistes: [
      ["Les presento la estrategia de este trimestre:", "menos bugs, más deploys.", "…y que el CI no se entere."],
      ["¿El roadmap?", "Va al día. Al día de hace tres semanas."],
    ],
  },
  manuel: {
    pose: "pensar",
    chistes: [
      ["Me visto de negro…", "…para que no se noten las manchas de café del debugging."],
      ["Los logs no mienten…", "…pero a veces se quedan callados."],
    ],
  },
};
