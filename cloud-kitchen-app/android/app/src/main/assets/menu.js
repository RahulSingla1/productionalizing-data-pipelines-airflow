// Swadishtam (Pure Veg) menu, copied from Swadishtam_Menu_High_Quality-3.pdf.
// Each dish: category, name, optional "has" (what is inside), and portions [label, price].
// A price of 0 means "MRP": the price is typed when the order is taken.
// Raise KB_MENU_VERSION whenever this list changes, so phones that never edited their menu get the new one.
window.KB_MENU_VERSION = 1;
window.KB_MENU = (function () {
  var Q = "Qtr", H = "Half", F = "Full";
  var menu = [];
  function add(cat, name, opts, has) { menu.push({ cat: cat, name: name, opts: opts, has: has || "" }); }

  // ---- Main Course (Qtr / Half / Full)
  [
    ["Paneer Lababdar", 150, 210, 350],
    ["Paneer Butter Masala", 160, 220, 360],
    ["Kadhai Paneer", 140, 190, 330],
    ["Shahi Paneer", 180, 290, 390],
    ["Shahi Paneer (with Gravy)", 190, 260, 380],
    ["Paneer Mushroom Masala", 140, 190, 330],
    ["Mushroom Do Pyaza", 160, 220, 360],
    ["Mushroom Masala", 160, 260, 370],
    ["Kadhai Mushroom", 150, 210, 270],
    ["Soya Champ Gravy", 160, 220, 280],
    ["Dal Makhani", 170, 220, 290],
    ["Dal Tadka (Black)", 120, 180, 240],
    ["Dal Fry (Yellow)", 110, 180, 180]
  ].forEach(function (d) { add("Main Course", d[0], [[Q, d[1]], [H, d[2]], [F, d[3]]]); });
  add("Main Course", "Jeera Rice", [[H, 130], [F, 190]]);
  add("Main Course", "Matar Pulao", [[H, 150], [F, 200]]);

  // ---- Indian Breads (one price)
  [
    ["Tandoori Roti", 14],
    ["Butter Tandoori Roti", 18],
    ["Butter Tandoori Roti (Green Chilli + Garlic)", 22],
    ["Missi Roti", 35],
    ["Punjabi Missi Roti", 45],
    ["Naan", 50],
    ["Butter Naan", 60],
    ["Lachha Paratha", 60],
    ["Green Chilli Lachha Paratha", 65],
    ["Garlic Lachha Paratha", 70]
  ].forEach(function (d) { add("Indian Breads", d[0], [["", d[1]]]); });

  // ---- Starters (Half / Full)
  [
    ["Paneer Tikka", 180, 280],
    ["Paneer Malai Tikka", 200, 290],
    ["Mushroom Tikka", 180, 230],
    ["Mushroom Masala Tikka", 200, 250],
    ["Soya Chaap Masala", 160, 200],
    ["Malai Soya Chaap", 180, 220],
    ["Veg. Seekh Kebab", 180, 260]
  ].forEach(function (d) { add("Starters", d[0], [[H, d[1]], [F, d[2]]]); });

  // ---- Snacks (Half / Full)
  [
    ["Dahi Kebab", 190, 240],
    ["Hari Bhari Balls", 80, 120],
    ["Hara Bhara Kebab", 180, 230],
    ["Cheese Shots", 90, 130],
    ["Veg. Manchurian", 170, 220],
    ["Veg. Spring Rolls", 90, 160],
    ["Mushroom Duplex", 190, 280],
    ["Cocktail Samosa", 80, 120]
  ].forEach(function (d) { add("Snacks", d[0], [[H, d[1]], [F, d[2]]]); });

  // ---- Combos
  ["Veg. Noodles + Veg Manchurian Gravy", "Fried Rice + Veg Manchurian Gravy", "Dal Makhani + 3 Tandoori Roti"]
    .forEach(function (n) { add("Combos", n, [["", 129]], "Combo @ 129"); });
  ["Veg. Noodles + Cheese Chilly", "Fried Rice + Cheese Chilly", "Cheese Naan + Gravy",
   "Dal Makhani + 1 Lachha Paratha + 1 Roti", "Dal Makhani + 1 Butter Naan + 1 Roti"]
    .forEach(function (n) { add("Combos", n, [["", 159]], "Combo @ 159"); });
  ["Kadhai Paneer + 1 Butter Naan + 1 Tandoori Roti", "Paneer Lababdar + 3 Butter Roti",
   "Paneer Butter Masala + 1 Missi Roti + Tandoori Roti", "Paneer Kadhai + 1 Lachha Paratha + 1 Tandoori Roti"]
    .forEach(function (n) { add("Combos", n, [["", 189]], "Combo @ 189"); });

  // ---- Thalis
  add("Thalis", "Special Thali", [["", 140]], "Dal Makhani + Mix Vegetable + 3 Roti + Salad + Raita");
  add("Thalis", "Deluxe Thali", [["", 220]], "Kadhai Paneer + Dal Makhani + Rice + 3 Roti + Raita + Salad");
  add("Thalis", "Super Deluxe Thali", [["", 260]], "Kadhai Paneer + Dal Makhani + Mix Vegetable + Rice + 3 Butter Roti + Raita + Salad");

  // ---- Platters
  add("Platters", "Indo-Chinese Feast", [["Fried Rice", 239], ["Noodles", 239]],
    "Fried Rice / Veg. Noodles + Veg Manchurian Gravy + Paneer Tikka 2pc + Veg. Seekh Kebab 2pc + Veg Spring Roll 2pc + Paneer Finger 2pc");
  add("Platters", "Continental Platter", [["", 249]],
    "2 pcs each: Dahi Kebab + Hara Bhara Kebab + Paneer Finger + Mushroom Duplex, with Kuchumber Salad, Mint Chutney, Ring Onion");
  add("Platters", "Tandoori Platter", [["", 299]],
    "2 pcs each: Masala Paneer Tikka + Veg. Seekh Kebab + Mushroom Tikka + Soya Malai Tikka, with Kuchumber Salad, Mint Chutney, Ring Onion");

  // ---- Beverages (MRP: type the price when ordering)
  ["Coke", "Diet Coke", "Limca", "Soda", "Water Bottle (1 Ltr)"].forEach(function (n) { add("Beverages", n, [["MRP", 0]]); });

  return menu.map(function (d, i) {
    return { id: "m" + (i + 1), cat: d.cat, name: d.name, has: d.has,
      opts: d.opts.map(function (o) { return { label: o[0], price: o[1] }; }) };
  });
})();
