# ProjectorCal: static web app. All camera work and analysis happen in the
# browser (localhost counts as a secure origin, so camera access is allowed),
# so the container only serves files.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
RUN printf '#!/bin/sh\necho "ProjectorCal: serving on :80 (open http://localhost:<published port>)"\n' > /docker-entrypoint.d/99-banner.sh \
 && chmod +x /docker-entrypoint.d/99-banner.sh
EXPOSE 80
