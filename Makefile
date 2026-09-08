UUID = burnline@jrydel.cz
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA = schemas/org.gnome.shell.extensions.burnline.gschema.xml
SOURCES = extension.js usage.js prefs.js
FILES = $(SOURCES) stylesheet.css metadata.json

.PHONY: help schemas install uninstall enable disable pack check

help:
	@echo "make schemas    compile schemas/gschemas.compiled"
	@echo "make install    copy the extension to $(INSTALL_DIR)"
	@echo "make uninstall  remove $(INSTALL_DIR)"
	@echo "make enable     gnome-extensions enable $(UUID)"
	@echo "make disable    gnome-extensions disable $(UUID)"
	@echo "make pack       build $(UUID).shell-extension.zip"
	@echo "make check      syntax-check every JS file"

schemas:
	glib-compile-schemas schemas/

install: schemas
	mkdir -p $(INSTALL_DIR)
	cp $(FILES) $(INSTALL_DIR)/
	cp -r icons schemas $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR). Log out and back in, then run: make enable"

uninstall:
	rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

pack:
	gnome-extensions pack --force --extra-source=usage.js --extra-source=icons --schema=$(SCHEMA)

# `node --check FILE.js` exits 0 without parsing when the file is detected as
# an ES module (Node 22), so feed it on stdin with the module type forced.
check:
	@for f in $(SOURCES); do node --input-type=module --check < $$f || exit 1; echo "$$f: ok"; done
