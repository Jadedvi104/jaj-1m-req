import { Body, Controller, Post } from '@nestjs/common';
import { CreateTableSessionDto } from './dto/create-table-session.dto';
import { TableSessionsService } from './table-sessions.service';

@Controller('table-sessions')
export class TableSessionsController {
  constructor(private readonly sessions: TableSessionsService) {}
  @Post() create(@Body() dto: CreateTableSessionDto) {
    return this.sessions.create(dto);
  }
}
