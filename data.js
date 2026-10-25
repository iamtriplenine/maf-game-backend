// MAF_MONOPOLY_V1_DATA : plateau et cartes (repris du projet Unity Monopoly-Local, sans 3D)
export const START_BALANCE = 1500;
export const GO_SALARY = 200;
export const JAIL_FEE = 50;

// type : go | prop | rail | util | tax | chest | chance | jail | parking | gojail
export const SQUARES = [
  { id: 0, type: 'go', name: 'GO' },
  { id: 1, type: 'prop', name: 'Mediterranean Avenue', price: 60, house: 50, rent: 2, group: 'brown' },
  { id: 2, type: 'chest', name: 'Community Chest' },
  { id: 3, type: 'prop', name: 'Baltic Avenue', price: 60, house: 50, rent: 4, group: 'brown' },
  { id: 4, type: 'tax', name: 'Income Tax', tax: 200 },
  { id: 5, type: 'rail', name: 'Reading Railroad', price: 200 },
  { id: 6, type: 'prop', name: 'Oriental Avenue', price: 100, house: 50, rent: 6, group: 'sky' },
  { id: 7, type: 'chance', name: 'Chance' },
  { id: 8, type: 'prop', name: 'Vermont Avenue', price: 100, house: 50, rent: 6, group: 'sky' },
  { id: 9, type: 'prop', name: 'Connecticut Avenue', price: 120, house: 50, rent: 8, group: 'sky' },
  { id: 10, type: 'jail', name: 'Jail' },
  { id: 11, type: 'prop', name: 'St. Charles Place', price: 140, house: 100, rent: 10, group: 'pink' },
  { id: 12, type: 'util', name: 'Electric Company', price: 150 },
  { id: 13, type: 'prop', name: 'States Avenue', price: 140, house: 100, rent: 10, group: 'pink' },
  { id: 14, type: 'prop', name: 'Virginia Avenue', price: 160, house: 100, rent: 12, group: 'pink' },
  { id: 15, type: 'rail', name: 'Pennsylvania Railroad', price: 200 },
  { id: 16, type: 'prop', name: 'St. James Place', price: 180, house: 100, rent: 14, group: 'orange' },
  { id: 17, type: 'chest', name: 'Community Chest' },
  { id: 18, type: 'prop', name: 'Tennessee Avenue', price: 180, house: 100, rent: 14, group: 'orange' },
  { id: 19, type: 'prop', name: 'New York Avenue', price: 200, house: 100, rent: 16, group: 'orange' },
  { id: 20, type: 'parking', name: 'Free Parking' },
  { id: 21, type: 'prop', name: 'Kentucky Avenue', price: 220, house: 150, rent: 18, group: 'red' },
  { id: 22, type: 'chance', name: 'Chance' },
  { id: 23, type: 'prop', name: 'Indiana Avenue', price: 220, house: 150, rent: 18, group: 'red' },
  { id: 24, type: 'prop', name: 'Illinois Avenue', price: 240, house: 150, rent: 20, group: 'red' },
  { id: 25, type: 'rail', name: 'B. & O. Railroad', price: 200 },
  { id: 26, type: 'prop', name: 'Atlantic Avenue', price: 260, house: 150, rent: 22, group: 'yellow' },
  { id: 27, type: 'prop', name: 'Ventnor Avenue', price: 260, house: 150, rent: 22, group: 'yellow' },
  { id: 28, type: 'util', name: 'Water Works', price: 150 },
  { id: 29, type: 'prop', name: 'Marvin Gardens', price: 280, house: 150, rent: 24, group: 'yellow' },
  { id: 30, type: 'gojail', name: 'Go To Jail' },
  { id: 31, type: 'prop', name: 'Pacific Avenue', price: 300, house: 200, rent: 26, group: 'green' },
  { id: 32, type: 'prop', name: 'North Carolina Avenue', price: 300, house: 200, rent: 26, group: 'green' },
  { id: 33, type: 'chest', name: 'Community Chest' },
  { id: 34, type: 'prop', name: 'Pennsylvania Avenue', price: 320, house: 200, rent: 28, group: 'green' },
  { id: 35, type: 'rail', name: 'Short Line', price: 200 },
  { id: 36, type: 'chance', name: 'Chance' },
  { id: 37, type: 'prop', name: 'Park Place', price: 350, house: 200, rent: 35, group: 'blue' },
  { id: 38, type: 'tax', name: 'Luxury Tax', tax: 100 },
  { id: 39, type: 'prop', name: 'Boardwalk', price: 400, house: 200, rent: 50, group: 'blue' },
];

// Groupes de couleur (l'original avait une faute : {31,32,24} au lieu de {31,32,34}, corrigee ici)
export const GROUPS = {
  brown: [1, 3], sky: [6, 8, 9], pink: [11, 13, 14], orange: [16, 18, 19],
  red: [21, 23, 24], yellow: [26, 27, 29], green: [31, 32, 34], blue: [37, 39],
};
export const GROUP_COLORS = {
  brown: '#8b4a2b', sky: '#9fd8f5', pink: '#d83a97', orange: '#f59a23',
  red: '#e32a2a', yellow: '#f6e22b', green: '#1fa24a', blue: '#1b5fc2',
};
export const RAILROADS = [5, 15, 25, 35];
export const UTILITIES = [12, 28];

// amount : argent (+ recu, - paye) ; moveTo : case de destination (ou null)
export const CHANCE_CARDS = [
  { id: 'c1', text: 'Tu es élu président du conseil. Paie 50 $ à la banque.', amount: -50, moveTo: null },
  { id: 'c2', text: 'Avance jusqu’à Boardwalk.', amount: 0, moveTo: 39 },
  { id: 'c3', text: 'Ton prêt immobilier arrive à échéance. Reçois 150 $.', amount: 150, moveTo: null },
  { id: 'c4', text: 'Avance jusqu’à la case GO.', amount: 0, moveTo: 0 },
  { id: 'c5', text: 'La banque te verse un dividende de 50 $.', amount: 50, moveTo: null },
  { id: 'c6', text: 'Réparations générales : paie 100 $.', amount: -100, moveTo: null },
  { id: 'c7', text: 'Avance jusqu’à St. Charles Place.', amount: 0, moveTo: 11 },
  { id: 'c8', text: 'Avance jusqu’à Illinois Avenue.', amount: 0, moveTo: 24 },
  { id: 'c9', text: 'VA EN PRISON, paie 50 $.', amount: -50, moveTo: 10 },
  { id: 'c10', text: 'Fais un voyage jusqu’à Reading Railroad.', amount: 0, moveTo: 5 },
  { id: 'c11', text: 'Excès de vitesse : amende de 15 $.', amount: -15, moveTo: null },
];
export const CHEST_CARDS = [
  { id: 'k1', text: 'Frais d’hôpital : paie 100 $.', amount: -100, moveTo: null },
  { id: 'k2', text: 'Vente d’actions : tu reçois 50 $.', amount: 50, moveTo: null },
  { id: 'k3', text: 'Remboursement d’impôts : reçois 20 $.', amount: 20, moveTo: null },
  { id: 'k4', text: 'C’est ton anniversaire. Reçois 30 $.', amount: 30, moveTo: null },
  { id: 'k5', text: 'Tu hérites de 100 $.', amount: 100, moveTo: null },
  { id: 'k6', text: 'Réparations de rue : paie 80 $.', amount: -80, moveTo: null },
  { id: 'k7', text: 'Ton fonds de vacances arrive à échéance. Reçois 100 $.', amount: 100, moveTo: null },
  { id: 'k8', text: 'Tu remportes le deuxième prix d’un concours de beauté. Reçois 10 $.', amount: 10, moveTo: null },
  { id: 'k9', text: 'Tu reçois 25 $ d’honoraires de conseil.', amount: 25, moveTo: null },
  { id: 'k10', text: 'Erreur de la banque en ta faveur. Reçois 200 $.', amount: 200, moveTo: null },
  { id: 'k11', text: 'VA EN PRISON, paie 50 $.', amount: -50, moveTo: 10 },
  { id: 'k12', text: 'Ton assurance-vie arrive à échéance. Reçois 100 $.', amount: 100, moveTo: null },
  { id: 'k13', text: 'Honoraires du médecin : paie 50 $.', amount: -50, moveTo: null },
  { id: 'k14', text: 'Avance jusqu’à la case GO.', amount: 0, moveTo: 0 },
  { id: 'k15', text: 'Frais de scolarité : paie 50 $.', amount: -50, moveTo: null },
];

// Pions (7 comme dans l'original : cannon, car, iron, locomotive, thimble, topHat, wheelbarrow)
export const PIECES = [
  { id: 'cannon', label: 'Canon', emoji: '💣' },
  { id: 'car', label: 'Voiture', emoji: '🚗' },
  { id: 'iron', label: 'Fer à repasser', emoji: '🧺' },
  { id: 'locomotive', label: 'Locomotive', emoji: '🚂' },
  { id: 'thimble', label: 'Dé à coudre', emoji: '🧵' },
  { id: 'topHat', label: 'Haut-de-forme', emoji: '🎩' },
  { id: 'wheelbarrow', label: 'Brouette', emoji: '🛒' },
];
export const PLAYER_COLORS = ['#e32a2a', '#1b5fc2', '#1fa24a', '#f59a23', '#d83a97', '#7a3fd1', '#12a8a8'];
