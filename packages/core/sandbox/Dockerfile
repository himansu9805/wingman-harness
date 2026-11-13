FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f

RUN apk add --no-cache python3

USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/bin/sleep", "infinity"]
