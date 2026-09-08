import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp, createHttpAdapter } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createHttpAdapter(),
  );
  configureApp(app);
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
void bootstrap();
