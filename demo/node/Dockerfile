FROM buildpack
ADD . /app
RUN herokuish buildpack build
ENV PORT 8080
WORKDIR /app
expose 8080
