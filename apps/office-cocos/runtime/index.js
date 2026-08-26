System.register(["./application.js"], function (_export, _context) {
  "use strict";

  var Application, application;

  function topLevelImport(url) {
    return System["import"](url);
  }

  return {
    setters: [function (_applicationJs) {
      Application = _applicationJs.Application;
    }],
    execute: function () {
      application = new Application();
      Promise.all([topLevelImport("cc"), topLevelImport("./src/office-runtime.js")])
        .then(function (modules) {
          var engine = modules[0];
          var office = modules[1];
          application.init(engine);
          engine.game.onStart = function () {
            office.startOffice(engine);
          };
          return application.start();
        })
        .catch(function (error) {
          console.error(error);
        });
    }
  };
});
