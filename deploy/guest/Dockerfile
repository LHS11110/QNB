# Adds debuggers to the QNB VM guest image for line-by-line C++ / Java execution.
#
#   docker tag qnb-runtime-guest:local qnb-runtime-guest:base      # once: keep the stock image
#   docker build -t qnb-runtime-guest:local deploy/guest            # rebuild after updating :base
#
# New VMs pick up the image when the runtime manager (re)creates their container.
ARG BASE=qnb-runtime-guest:base
FROM ${BASE}
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends gdb openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && gdb --version | head -1 && javac -version
USER 1000:1000
