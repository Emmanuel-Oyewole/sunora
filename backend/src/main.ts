import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule, ObserveInstrument } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_ENV, type AppEnv } from './shared/config/env.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  const env = app.get<AppEnv>(APP_ENV);
  configureApp(app, env);

  const config = new DocumentBuilder()
    .setTitle('Sunora')
    .setDescription('AI chat application')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(env.port);
}
await bootstrap();
