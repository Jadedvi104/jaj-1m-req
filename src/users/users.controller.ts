import { User } from './entities/user.entity';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}
  @Post() create(@Body() dto: CreateUserDto): User {
    return this.usersService.create(dto);
  }
  @Get() findAll(): User[] {
    return this.usersService.findAll();
  }
  @Get(':id') findOne(@Param('id', ParseIntPipe) id: number): User {
    return this.usersService.findOne(id);
  }
  @Patch(':id') update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ): User {
    return this.usersService.update(id, dto);
  }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number): User {
    return this.usersService.remove(id);
  }
}
