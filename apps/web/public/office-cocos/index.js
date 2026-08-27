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
          console.info("agent-market.office.bootstrap.modules-ready");
          document.documentElement.dataset.officeBootstrap = "modules-ready";
          var engine = modules[0];
          var office = modules[1];
          application.init(engine);
          engine.game.onStart = function () {
            console.info("agent-market.office.bootstrap.game-start");
            document.documentElement.dataset.officeBootstrap = "game-start";
            office.startOffice(engine);
          };
          return application.start();
        })
        .catch(function (error) {
          document.documentElement.dataset.officeBootstrap = "error";
          document.documentElement.dataset.officeError = String(error && error.message || error).slice(0, 180);
          console.error(error);
        });
    }
  };
});
