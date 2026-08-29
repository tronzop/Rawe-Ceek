FROM node:22-alpine
WORKDIR /app
COPY . .
# The shipped meme-pack voice clips are kept aside so a host-mounted
# assets/clips (Unraid appdata) can be seeded with them on first start.
RUN mv assets/clips assets/clips-default && mkdir -p assets/clips assets/drivers \
  && printf '#!/bin/sh\nset -e\n# seed the (possibly bind-mounted) clips folder with shipped voice clips that are missing\nfor f in /app/assets/clips-default/*; do [ -f "$f" ] || continue; n=$(basename "$f"); [ -e "/app/assets/clips/$n" ] || cp "$f" "/app/assets/clips/$n"; done\nexec "$@"\n' > /entrypoint.sh \
  && chmod +x /entrypoint.sh
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:8080/healthz || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
