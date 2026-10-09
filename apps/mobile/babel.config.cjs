// Metro's Babel preset. Expo owns the transform; nothing custom belongs here
// unless a dependency demands it, and anything added should say why.
module.exports = function (api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
