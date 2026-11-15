// Référentiels : catégories, groupes, mesures, états Vinted.
export const CATEGORIES = {
  'Chemise': 'haut', 'Polo': 'haut', 'T-shirt': 'haut', 'Haut (autre)': 'haut',
  'Pull': 'maille', 'Gilet': 'maille', 'Sweat': 'maille',
  'Veste': 'dessus', 'Blazer': 'dessus', 'Surchemise': 'dessus', 'Manteau': 'dessus', 'Doudoune': 'dessus', 'Imperméable': 'dessus',
  'Pantalon': 'bas', 'Jean': 'bas', 'Chino': 'bas', 'Short': 'bas',
  'Chaussures': 'chaussures',
  'Écharpe': 'accessoire', 'Gants': 'accessoire', 'Bonnet / chapeau': 'accessoire', 'Ceinture': 'accessoire',
  'Cravate': 'accessoire', 'Chaussettes': 'accessoire', 'Accessoire (autre)': 'accessoire',
};

export const GROUPS = {
  haut: { label: 'Hauts', icon: 'apparel' },
  maille: { label: 'Mailles', icon: 'styler' },
  dessus: { label: 'Vestes & manteaux', icon: 'checkroom' },
  bas: { label: 'Bas', icon: 'straighten' },
  chaussures: { label: 'Chaussures', icon: 'steps' },
  accessoire: { label: 'Accessoires', icon: 'diamond' },
};
export const GROUP_ORDER = ['dessus', 'maille', 'haut', 'bas', 'chaussures', 'accessoire'];

export const groupOf = (cat) => CATEGORIES[cat] || 'accessoire';

export const MEASURES = {
  haut: [['longueur', 'Longueur'], ['aisselles', 'Aisselle à aisselle'], ['epaules', 'Épaules'], ['manche', 'Longueur de manche']],
  maille: [['longueur', 'Longueur'], ['aisselles', 'Aisselle à aisselle'], ['epaules', 'Épaules'], ['manche', 'Longueur de manche']],
  dessus: [['longueur', 'Longueur'], ['aisselles', 'Aisselle à aisselle'], ['epaules', 'Épaules'], ['manche', 'Longueur de manche']],
  bas: [['tailleAPlat', 'Tour de taille à plat'], ['hanchesAPlat', 'Hanches à plat'], ['entrejambe', 'Entrejambe'], ['longueurTotale', 'Longueur totale'], ['basJambe', 'Bas de jambe']],
  chaussures: [['semelle', 'Longueur semelle intérieure']],
  accessoire: [['longueur', 'Longueur'], ['largeur', 'Largeur']],
};

export const ETATS = ['Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant'];
export const SAISONS = ['printemps', 'été', 'automne', 'hiver'];

export const STATUTS = {
  garde: { label: 'Gardé', icon: 'favorite' },
  a_vendre: { label: 'À vendre', icon: 'sell' },
  en_vente: { label: 'En ligne', icon: 'storefront' },
  vendu: { label: 'Vendu', icon: 'paid' },
  donne: { label: 'Donné / jeté', icon: 'volunteer_activism' },
};

export const FORMALITE = ['', 'Très décontracté', 'Décontracté', 'Smart casual', 'Habillé', 'Très habillé'];
export const CHALEUR = ['', 'Très léger', 'Léger', 'Moyen', 'Chaud', 'Très chaud'];

export const PROFILE_MEASURES = [
  ['tailleCm', 'Taille (cm)'], ['poids', 'Poids (kg, optionnel)'], ['cou', 'Tour de cou'],
  ['poitrine', 'Tour de poitrine'], ['tourTaille', 'Tour de taille'], ['hanches', 'Tour de hanches'],
  ['epaules', 'Largeur d’épaules'], ['bras', 'Longueur de bras'], ['entrejambe', 'Entrejambe'], ['pointure', 'Pointure (EU)'],
];
export const PROFILE_SIZES = [
  ['tHaut', 'Haut (S, M, L…)'], ['tChemise', 'Chemise (col, ex. 40)'], ['tPantalon', 'Pantalon (ex. 40 ou W32 L32)'], ['tVeste', 'Veste (ex. 48)'],
];
export const PROFILE_TASTES = [
  ['style', 'Mon style', 'Ex. classique, sobre, plutôt habillé ; j’aime les chemises et les pulls col V…'],
  ['couleursAimees', 'Couleurs que j’aime porter', 'Ex. marine, gris, bordeaux, vert bouteille'],
  ['couleursEvitees', 'Couleurs ou motifs à éviter', 'Ex. orange, imprimés voyants'],
  ['coupes', 'Coupes préférées', 'Ex. coupe droite, pas de skinny'],
  ['matieres', 'Matières aimées / à éviter', 'Ex. laine, coton ; pas de polyester'],
  ['interdits', 'À ne jamais me proposer', 'Ex. short, t-shirt seul en semaine'],
  ['contraintes', 'Contexte et contraintes', 'Ex. cours à la fac, trajets à pied, tenue correcte le dimanche'],
  ['regles', 'Règles de style précises', 'Ex. 1 cm de manchette de chemise qui dépasse du pull, revers au bas des pantalons, pas de passants de ceinture…'],
  ['referentielAchat', 'Référentiel de tailles pour les achats', 'Ex. pantalon : tour de taille à plat 38,5–39 cm, entrejambe 77–78 cm, ouverture 17,5–18 cm…'],
];
