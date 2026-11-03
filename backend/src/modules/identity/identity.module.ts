import { Module } from '@nestjs/common';
import { UserRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  providers: [UserRepository, UsersService],
})
export class IdentityModule {}
